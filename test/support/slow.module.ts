import { Controller, Get, Module } from '@nestjs/common';

/** Ruta solo de pruebas: una petición lenta para observar el cierre ordenado. */
@Controller('test')
class SlowController {
  @Get('slow')
  async slow(): Promise<{ done: true }> {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return { done: true };
  }
}

@Module({ controllers: [SlowController] })
export class SlowModule {}
