import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsPositive, ValidateNested } from 'class-validator';
import { JsonString, NotBlank, Size } from '../../src/common/bean-validation.js';
import { ApiException } from '../../src/common/api-exception.js';

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

  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }
}

@Module({ controllers: [FailingController] })
export class FailingModule {}
