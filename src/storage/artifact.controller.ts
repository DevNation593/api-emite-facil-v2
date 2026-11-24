import { Controller, Get, Inject, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Kysely } from 'kysely';
import { DocumentKinds } from '../billing/document-kind.js';
import { ApiException } from '../common/api-exception.js';
import { CACHE_HEADERS } from '../common/security-headers.middleware.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { artifactKindOf, mediaTypeOf, pathNameOf } from './artifact-kind.js';
import { ArtifactStore } from './artifact-store.js';

/** Si alguna de las etiquetas de If-None-Match es esa, sin distinguir las débiles; `*` no cuenta, como en Spring. */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  for (const [, tag] of (ifNoneMatch ?? '').matchAll(/(?:W\/)?("[^"]*")/g)) if (tag === etag) return true;
  return false;
}

/** Descarga de los artefactos de un comprobante de la empresa activa, como storage/ArtifactController.java. */
@Controller('documents/:id/artifacts')
@UseGuards(TenantAccessGuard)
export class ArtifactController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly artifacts: ArtifactStore,
    private readonly kinds: DocumentKinds,
  ) {}

  @Get(':kind')
  async download(
    @Tenant() access: TenantAccess,
    @Param('id', UuidPipe) id: string,
    @Param('kind') kind: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const artifactKind = artifactKindOf(kind);
    if (artifactKind === null) throw new ApiException(400, 'MALFORMED_REQUEST', 'Tipo de artefacto desconocido');
    // Un documento ajeno y un artefacto aún no generado responden igual.
    const artifact = await this.artifacts.findForDownload(this.db, access.tenantId, id, artifactKind);
    if (artifact === null) throw ApiException.notFound();
    const mediaType = mediaTypeOf(artifactKind);
    const extension = mediaType === 'application/pdf' ? '.pdf' : '.xml';
    const stem = this.kinds.find(artifact.documentType)?.fileStem ?? 'comprobante';
    const etag = `"${artifact.sha256}"`;
    res.setHeader('ETag', etag);
    // Con nombre propio y como adjunto: el navegador lo guarda, no lo abre dentro del sitio.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${stem}-${artifact.number}-${pathNameOf(artifactKind)}${extension}"`,
    );
    if (matchesEtag(req.headers['if-none-match'], etag)) {
      for (const name of Object.keys(CACHE_HEADERS)) res.removeHeader(name);
      res.status(304).end();
      return;
    }
    // res.end y no res.send: el tipo va tal cual, sin la negociación ni el charset de Express.
    res.status(200);
    res.setHeader('Content-Type', mediaType);
    res.setHeader('Content-Length', artifact.content.length);
    res.end(artifact.content);
  }
}
