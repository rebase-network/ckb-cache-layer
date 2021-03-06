import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from 'nest-schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { configService } from './config/config.service';
import { BlockModule } from './block/block.module';
import { CellModule } from './cell/cell.module';
import { CkbModule } from './ckb/ckb.module';
import { AddressModule } from './address/address.module';
import { SyncstatModule } from './syncstat/syncstat.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(configService.getTypeOrmConfig()),
    ScheduleModule.register(),
    BlockModule,
    CellModule,
    CkbModule,
    AddressModule,
    SyncstatModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
