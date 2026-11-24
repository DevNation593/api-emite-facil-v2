import {
  Body,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  Module,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { IsPositive, ValidateNested } from 'class-validator';
import { JsonString, NotBlank, Size } from '../../src/common/bean-validation.js';
import { AcceptsMultipart } from '../../src/common/validation.js';
import { ApiException } from '../../src/common/api-exception.js';
import { UuidPipe } from '../../src/common/uuid.pipe.js';

class LineDto {
  @IsPositive()
  quantity!: number;

  @JsonString()
  @Size({ max: 1000 })
  description?: string;
}

class EchoDto {
  @JsonString()
  @NotBlank()
  name!: string;

  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines!: LineDto[];
}

/** Rutas solo de pruebas para observar el tratamiento de cada tipo de error. */
@Controller('test')
class FailingController {
  @Get('boom')
  boom(): never {
    throw new Error('fallo provocado por la prueba: secreto-interno');
  }

  @Get('http-500')
  http500(): never {
    throw new InternalServerErrorException('fallo de Nest: secreto-interno');
  }

  @Get('api-exception')
  apiException(): never {
    throw new ApiException(
      422,
      'WEAK_PASSWORD',
      'La contraseña no es válida',
      [{ field: 'password', message: 'x' }],
      30,
    );
  }

  /** Como las subidas de certificados de E3: el cuerpo multipart no da 415. */
  @Post('multipart')
  @HttpCode(200)
  @AcceptsMultipart()
  multipart(@Body() _body: unknown): { ok: boolean } {
    return { ok: true };
  }

  /** Una descarga que falla con las cabeceras y parte del cuerpo ya enviados. */
  @Get('cut')
  async cut(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'application/pdf');
    res.write('%PDF-1.5 a medias');
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error('fallo a mitad de la descarga: secreto-interno');
  }

  @Put('echo/:id')
  replace(@Param('id', UuidPipe) id: string, @Body() body: EchoDto): unknown {
    return { id, body };
  }

  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }
}

@Module({ controllers: [FailingController] })
export class FailingModule {}
