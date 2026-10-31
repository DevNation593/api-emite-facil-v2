import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import {
  CredentialsDto,
  EmailRequestDto,
  LinkRequestDto,
  RefreshRequestDto,
  ResetRequestDto,
} from './auth.dto.js';
import { AuthService, type Tokens } from './auth.service.js';
import { clientAddress } from './client-address.js';

/**
 * Cuentas y sesiones. Todo es público salvo /me, /email-verification/resend y /password (que
 * llegan con la autenticación). La API no está expuesta al navegador: la IP del usuario la pasa
 * la web en X-Forwarded-For, y se lee como explica `clientAddress`.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('register')
  @HttpCode(202)
  async register(@Body() request: CredentialsDto): Promise<void> {
    await this.service.register(request.email, request.password);
  }

  @Post('login')
  @HttpCode(200)
  login(
    @Body() request: CredentialsDto,
    @Req() http: Request,
  ): Promise<Tokens> {
    return this.service.login(request.email, request.password, this.clientIp(http));
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() request: RefreshRequestDto): Promise<Tokens> {
    return this.service.refresh(request.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() request: RefreshRequestDto): Promise<void> {
    await this.service.logout(request.refreshToken);
  }

  @Post('email-verification')
  @HttpCode(204)
  async verifyEmail(@Body() request: LinkRequestDto): Promise<void> {
    await this.service.verifyEmail(request.token);
  }

  @Post('password-reset/request')
  @HttpCode(202)
  async requestPasswordReset(
    @Body() request: EmailRequestDto,
    @Req() http: Request,
  ): Promise<void> {
    await this.service.requestPasswordReset(request.email, this.clientIp(http));
  }

  @Post('password-reset')
  @HttpCode(204)
  async resetPassword(@Body() request: ResetRequestDto): Promise<void> {
    await this.service.resetPassword(request.token, request.newPassword);
  }

  private clientIp(http: Request): string {
    return clientAddress(
      http.headers['x-forwarded-for'],
      http.socket.remoteAddress,
      this.config.auth.trustedProxyHops,
    );
  }
}
