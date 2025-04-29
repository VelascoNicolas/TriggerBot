import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [BotModule, EventEmitterModule.forRoot()],
  controllers: [],
  providers: [],
})
export class AppModule {}
