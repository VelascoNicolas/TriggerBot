import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { PrismaClient } from '@prisma/client';
import { equal } from 'joi';
import { equals } from 'class-validator';

const rm = promisify(fs.rm);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class BotService implements OnModuleInit {
  private client: Client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      protocolTimeout: 600000, // Increase the protocol timeout to 60 seconds
    },
  });
  private prisma = new PrismaClient();
  private enterpriseId: string;
  private logger = new Logger(BotService.name);
  private lastMessages = new Map<string, string>();
  private count: number = 0;
  private ending: boolean = false;

  constructor(private eventEmitter: EventEmitter2) {}

  onModuleInit() {
    this.client.on('qr', (qr) => {
      this.logger.log('QR RECEIVED', qr);
      this.eventEmitter.emit('qrcode.created', qr);
    });
    this.client.on('ready', async () => {
      this.logger.log("You're connected successfully!");
    });

    this.client.on('message', async (msg) => {
      this.logger.verbose(`${msg.from}: ${msg.body}`);

      if(this.count === 0 || this.ending === true) {
        const prompt = await this.prisma.prompt.findFirst({
          where: {
            enterpriseId: this.enterpriseId,
            available: true,
          },
        });
        if (!prompt) {
          this.logger.warn('No prompt found for the enterprise.');
          return;
        }
        this.count++;
        this.ending = false; // Reset ending to false after sending the prompt
        this.lastMessages.set(msg.from, prompt.body); // Store the prompt body as the last message
        msg.reply(prompt.body);
        return;
      }

      const reply = await this.prisma.messages.findFirst({
        where: {
          enterpriseId: this.enterpriseId,
          available: true,
          trigger: {
            equals: msg.body,
            mode: 'insensitive', // Add mode for case-insensitive comparison
          },
        },
      });

      if (!reply) {
        this.logger.warn(`No reply found for trigger: ${msg.body}`);
        const lastSentMessage = this.lastMessages.get(msg.from) || ''; // Default to empty string if none found
        msg.reply(lastSentMessage);
      } else {
        this.lastMessages.set(msg.from, reply.body);
        if(reply.ending === true) {
          this.ending = true; // Set ending to true if the reply is marked as ending
        }
        msg.reply(reply.body);
      }
    });

    this.client.initialize();
  }

  async setEnterpriseId(id: string) {
    this.enterpriseId = id;
  }

  async disconnect() {
    const cachePath = path.join(__dirname, '..', '..', '.wwebjs_cache');

    const deleteFolder = async (folderPath: string) => {
      try {
        if (fs.existsSync(folderPath)) {
          await rm(folderPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (error.code === 'EBUSY') {
          this.logger.warn(`Resource busy, retrying: ${folderPath}`);
          await sleep(1000);
          await deleteFolder(folderPath);
        } else {
          throw error;
        }
      }
    };

    try {
      await deleteFolder(cachePath);
      await this.client.logout();
      this.logger.log('Client disconnected and folders deleted successfully.');
      this.client.initialize(); // Reiniciar el cliente después de la desconexión
      this.logger.log('Client initialized again.');
    } catch (error) {
      this.logger.error(`Error while cleaning up: ${error.message}`);
    }
  }
}
