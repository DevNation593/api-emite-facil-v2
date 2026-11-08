import { Module } from '@nestjs/common';
import { XsdValidator } from './xsd-validator.js';

/** Validación XSD de los comprobantes; las reglas del sobre son funciones puras de `envelope-rules.ts`. */
@Module({
  providers: [{ provide: XsdValidator, useFactory: () => new XsdValidator() }],
  exports: [XsdValidator],
})
export class XmlModule {}
