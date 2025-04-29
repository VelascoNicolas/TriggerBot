import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import * as qrcode from 'qrcode-terminal';
import { promisify } from 'util';

const rm = promisify(fs.rm);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ClientState = {
  lastMessages: Map<string, string>;
  count: number;
  ending: boolean;
};

@Injectable()
export class BotService implements OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly prisma = new PrismaClient();
  private readonly clients = new Map<string, Client>();
  private readonly clientStates = new Map<string, ClientState>();

  constructor(private eventEmitter: EventEmitter2) {}

  async initializeClient(enterpriseId: string): Promise<Client | null> {
    if (this.clients.has(enterpriseId)) {
      this.logger.log(`Client for enterprise ${enterpriseId} already exists.`);
      return this.clients.get(enterpriseId) ?? null;
    }

    this.logger.log(`Initializing new client for enterprise: ${enterpriseId}`);
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: enterpriseId,
        dataPath: path.join(__dirname, '..', '..', '.wwebjs_auth'),
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      },
    });

    this.clients.set(enterpriseId, client);

    const state: ClientState = {
      lastMessages: new Map<string, string>(),
      count: 0,
      ending: false,
    };
    this.clientStates.set(enterpriseId, state);

    client.on('qr', (qr) => {
      this.logger.log(`[${enterpriseId}] QR Code Received. Scan below:`);
      qrcode.generate(qr, { small: true });
      this.eventEmitter.emit('qrcode.created', { enterpriseId, qr });
    });

    client.on('ready', () => {
      this.logger.log(`[${enterpriseId}] Client is ready!`);
      const currentState = this.clientStates.get(enterpriseId);
      if (currentState) {
        currentState.count = 0;
        currentState.ending = false;
      }
    });

    client.on('message', async (msg) => {
      await this.handleMessage(enterpriseId, msg);
    });

    client.on('auth_failure', (msg) => {
      this.logger.error(`[${enterpriseId}] Authentication Failure: ${msg}`);
      this.disconnectClient(enterpriseId);
    });

    client.on('disconnected', (reason) => {
      this.logger.warn(`[${enterpriseId}] Client was logged out: ${reason}`);
      this.disconnectClient(enterpriseId);
    });

    try {
      await client.initialize();
      this.logger.log(`[${enterpriseId}] Client initialization process started.`);
      return client;
    } catch (error) {
      this.logger.error(`[${enterpriseId}] Failed to initialize client: ${error.message || error}`);
      this.clients.delete(enterpriseId);
      this.clientStates.delete(enterpriseId);
      await this.deleteSessionData(enterpriseId);
      return null;
    }
  }

  private async handleMessage(enterpriseId: string, msg: Message) {
    if (msg.fromMe || msg.from === 'status@broadcast') return;

    this.logger.verbose(`[${enterpriseId}] Message from ${msg.from}: ${msg.body}`);

    const currentState = this.clientStates.get(enterpriseId);
    const currentClient = this.clients.get(enterpriseId);

    if (!currentState || !currentClient) {
      this.logger.error(`[${enterpriseId}] State or Client not found for message handling from ${msg.from}.`);
      return;
    }

    const chatId = msg.from;

    try {
      if (currentState.count === 0 || currentState.ending) {
        const prompt = await this.prisma.prompt.findFirst({
          where: { enterpriseId: enterpriseId, available: true },
        });
        if (!prompt) {
          this.logger.warn(`[${enterpriseId}] No prompt found.`);
          return;
        }
        currentState.count++;
        currentState.ending = false;
        currentState.lastMessages.set(chatId, prompt.body);
        await currentClient.sendMessage(chatId, prompt.body);
        return;
      }

      const reply = await this.prisma.messages.findFirst({
        where: {
          enterpriseId: enterpriseId,
          available: true,
          trigger: { equals: msg.body, mode: 'insensitive' },
        },
      });

      if (!reply) {
        this.logger.warn(`[${enterpriseId}] No reply for trigger: "${msg.body}" from ${chatId}`);
        const lastSentMessage = currentState.lastMessages.get(chatId);
        if (lastSentMessage) {
          await currentClient.sendMessage(chatId, lastSentMessage);
        } else {
          this.logger.verbose(`[${enterpriseId}] No last message found for ${chatId}, not sending default reply.`);
        }
      } else {
        currentState.lastMessages.set(chatId, reply.body);
        if (reply.ending === true) {
          currentState.ending = true;
          this.logger.log(`[${enterpriseId}] Conversation ending flag set for ${chatId}.`);
        }
        await currentClient.sendMessage(chatId, reply.body);
      }
    } catch (error) {
      this.logger.error(`[${enterpriseId}] Error handling message from ${chatId}: ${error.message || error}`);
      if (error.message?.includes('ERR_NETWORK_CHANGED') || error.message?.includes('Connection closed')) {
        this.logger.warn(`[${enterpriseId}] Network or connection error detected. Client might disconnect.`);
      } else if (error.message?.includes('Target closed')) {
        this.logger.warn(`[${enterpriseId}] Puppeteer target closed. Client might disconnect.`);
      }
    }
  }

  async disconnectClient(enterpriseId: string) {
    const client = this.clients.get(enterpriseId);
    if (!client) {
      this.logger.warn(`[${enterpriseId}] Client not found for disconnection.`);
      return;
    }

    this.logger.log(`[${enterpriseId}] Attempting to disconnect client...`);
    try {
      if (typeof client.destroy === 'function') {
        await client.destroy();
        this.logger.log(`[${enterpriseId}] Client destroyed.`);
      } else {
        await client.logout();
        this.logger.log(`[${enterpriseId}] Client logged out.`);
      }
    } catch (error) {
      this.logger.error(`[${enterpriseId}] Error during client destroy/logout: ${error.message || error}`);
    } finally {
      this.clients.delete(enterpriseId);
      this.clientStates.delete(enterpriseId);
      this.logger.log(`[${enterpriseId}] Client instance removed from service map.`);
      await this.deleteSessionData(enterpriseId);
    }
  }

  private async deleteSessionData(enterpriseId: string) {
    const sessionFolderPath = path.join(__dirname, '..', '..', '.wwebjs_auth', `session-${enterpriseId}`);
    const legacySessionFolderPath = path.join(__dirname, '..', '..', `.wwebjs_auth-${enterpriseId}`);

    const deleteFolder = async (folderPath: string) => {
      try {
        if (fs.existsSync(folderPath)) {
          this.logger.log(`[${enterpriseId}] Attempting to delete session folder: ${folderPath}`);
          await rm(folderPath, { recursive: true, force: true });
          this.logger.log(`[${enterpriseId}] Successfully deleted session folder: ${folderPath}`);
        }
      } catch (error) {
        if (error.code === 'EBUSY') {
          this.logger.warn(`[${enterpriseId}] Resource busy, retrying deletion: ${folderPath}`);
          await sleep(1000);
          await deleteFolder(folderPath);
        } else {
          this.logger.error(`[${enterpriseId}] Error deleting session folder ${folderPath}: ${error.message || error}`);
        }
      }
    };

    await deleteFolder(sessionFolderPath);
    await deleteFolder(legacySessionFolderPath);
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down BotService. Disconnecting all clients...');
    const disconnectionPromises = Array.from(this.clients.keys()).map((enterpriseId) =>
      this.disconnectClient(enterpriseId),
    );
    await Promise.allSettled(disconnectionPromises);
    this.logger.log('All clients disconnected.');
    await this.prisma.$disconnect();
  }

  getClient(enterpriseId: string): Client | undefined {
    return this.clients.get(enterpriseId);
  }
}
