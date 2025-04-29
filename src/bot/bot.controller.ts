import { Controller, Get, Param, Post, Res, NotFoundException, HttpCode, HttpStatus, Sse } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { Response } from 'express';
import { OnEvent } from '@nestjs/event-emitter';
import { BotService } from './bot.service';
import { Observable, Subject, map } from 'rxjs';

interface QrEvent {
  enterpriseId: string;
  qr: string | null; // QR string or null if ready/disconnected
}

@Controller('bot')
export class BotController {
  // Store QR codes temporarily, keyed by enterpriseId
  private qrCodes = new Map<string, string | null>();
  // Subject for Server-Sent Events
  private qrEventSubject = new Subject<QrEvent>();

  constructor(private botService: BotService) {}

  // Listen for QR code creation event from the service
  @OnEvent('qrcode.created')
  handleQrcodeCreatedEvent(payload: { enterpriseId: string; qr: string }) {
    this.qrCodes.set(payload.enterpriseId, payload.qr);
    // Emit event for SSE
    this.qrEventSubject.next({ enterpriseId: payload.enterpriseId, qr: payload.qr });
    console.log(`QR stored for ${payload.enterpriseId}`);
  }

  // Listen for client ready event from the service (needs to be emitted)
  @OnEvent('client.ready')
  handleClientReadyEvent(payload: { enterpriseId: string }) {
    // Clear QR code when client is ready
    if (this.qrCodes.has(payload.enterpriseId)) {
      this.qrCodes.set(payload.enterpriseId, null); // Set to null or delete
      this.qrEventSubject.next({ enterpriseId: payload.enterpriseId, qr: null }); // Notify SSE clients
      console.log(`QR cleared for ready client ${payload.enterpriseId}`);
    }
  }

  // Listen for client disconnected event (needs to be emitted)
  @OnEvent('client.disconnected')
  handleClientDisconnectedEvent(payload: { enterpriseId: string }) {
    if (this.qrCodes.has(payload.enterpriseId)) {
      this.qrCodes.set(payload.enterpriseId, null); // Clear QR on disconnect
      this.qrEventSubject.next({ enterpriseId: payload.enterpriseId, qr: null }); // Notify SSE clients
      console.log(`QR cleared for disconnected client ${payload.enterpriseId}`);
    }
  }

  // Endpoint to initiate client initialization
  @Post('initialize/:enterpriseId')
  @HttpCode(HttpStatus.ACCEPTED) // Indicate request accepted, processing started
  async initialize(@Param('enterpriseId') enterpriseId: string): Promise<{ message: string }> {
    // Don't wait for initialization, just start it
    this.botService.initializeClient(enterpriseId);
    return { message: `Initialization process started for enterprise ${enterpriseId}. Check GET /bot/qrcode/${enterpriseId} for QR code.` };
  }

  // Endpoint to get the current QR code as an image (if available)
  @Get('qrcode/image/:enterpriseId')
  async getQrCodeImage(@Res() response: Response, @Param('enterpriseId') enterpriseId: string) {
    const qr = this.qrCodes.get(enterpriseId);

    if (!qr) {
      // Check client status if QR is not in map
      const client = this.botService.getClient(enterpriseId);
      let statusMessage = 'QR code not available.';
      if (client) {
        try {
          const state = await client.getState();
          if (state === 'CONNECTED') {
            statusMessage = 'Client is already connected.';
          } else {
            statusMessage = `Client status: ${state || 'UNKNOWN'}. Try initializing.`;
          }
        } catch (e) {
          statusMessage = 'Client not running or in error state. Try initializing.';
        }
      } else {
        statusMessage = 'Client not initialized for this enterprise.';
      }
      throw new NotFoundException(statusMessage);
    }

    response.setHeader('Content-Type', 'image/png');
    try {
      QRCode.toFileStream(response, qr);
    } catch (error) {
      console.error(`Failed to generate QR stream for ${enterpriseId}:`, error);
      response.status(500).send('Failed to generate QR code image.');
    }
  }

  // Endpoint for Server-Sent Events to push QR updates
  @Sse('qrcode/stream/:enterpriseId')
  sseQrCode(@Param('enterpriseId') enterpriseId: string): Observable<MessageEvent> {
    return this.qrEventSubject.asObservable().pipe(
      // Filter events for the requested enterpriseId
      map((event: QrEvent): MessageEvent => {
        // Send the current QR when a client first connects
        if (event.enterpriseId === enterpriseId) {
          return new MessageEvent('qr_update', { data: JSON.stringify({ qr: event.qr }) });
        }
        // Send an empty message or specific event if needed for other enterprises,
        // but typically you only care about the one requested.
        // For simplicity, we might just filter it out if not matching.
        // However, sending the initial state is useful. Let's send the current state on connect.
        const currentQr = this.qrCodes.get(enterpriseId);
        return new MessageEvent('initial_state', { data: JSON.stringify({ qr: currentQr }) });
      }),
      // Alternatively, strictly filter:
      // filter(event => event.enterpriseId === enterpriseId),
      // map((event: QrEvent): MessageEvent => {
      //     return new MessageEvent('qr_update', { data: JSON.stringify({ qr: event.qr }) });
      // })
    );
  }

  // Endpoint to disconnect a specific client
  @Post('disconnect/:enterpriseId')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Param('enterpriseId') enterpriseId: string): Promise<{ message: string }> {
    await this.botService.disconnectClient(enterpriseId);
    // Also clear QR code from map on explicit disconnect
    if (this.qrCodes.has(enterpriseId)) {
      this.qrCodes.set(enterpriseId, null);
      this.qrEventSubject.next({ enterpriseId: enterpriseId, qr: null }); // Notify SSE
    }
    return { message: `Disconnect process initiated for enterprise ${enterpriseId}.` };
  }
}

// Helper interface for SSE MessageEvent (can be placed elsewhere)
class MessageEvent {
  constructor(public type: string, public data: any) {}
}
