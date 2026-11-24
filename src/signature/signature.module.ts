import { Module } from '@nestjs/common';
import { XadesVerifier } from './xades-verifier.js';
import { XadesBesSigner } from './xades-signer.js';

/** Firma XAdES-BES y su verificación con el perfil del SRI. */
@Module({
  providers: [
    { provide: XadesBesSigner, useFactory: () => new XadesBesSigner() },
    { provide: XadesVerifier, useFactory: () => new XadesVerifier() },
  ],
  exports: [XadesBesSigner, XadesVerifier],
})
export class SignatureModule {}
