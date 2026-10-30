import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';

// Raíz de la aplicación. Los módulos de dominio se irán importando aquí.
@Module({ imports: [ConfigModule] })
export class AppModule {}
