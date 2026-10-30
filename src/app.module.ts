import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './observability/health.controller.js';

// Raíz de la aplicación. Los módulos de dominio se irán importando aquí.
@Module({ imports: [CommonModule, ConfigModule, DatabaseModule, HealthModule] })
export class AppModule {}
