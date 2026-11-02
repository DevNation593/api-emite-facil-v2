import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import {
  ChangePasswordRequestDto,
  CredentialsDto,
  EmailRequestDto,
  LinkRequestDto,
  RefreshRequestDto,
  ResetRequestDto,
} from './auth.dto.js';
import { AuthService, type Tokens } from './auth.service.js';
import { clientAddress } from './client-address.js';
import { CurrentUser, CurrentUserGuard } from './current-user.guard.js';
import type { UserIdentity } from './request-identity.js';

/**
 * Cuentas y sesiones. Todo es público salvo /me, /email-verification/resend y /password, que
 * exigen la sesión de una persona (CurrentUserGuard). La API no está expuesta al navegador: la
 * IP del usuario la pasa la web en X-Forwarded-For, y se lee como explica `clientAddress`.
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

  @Post('email-verification/resend')
  @HttpCode(202)
  @UseGuards(CurrentUserGuard)
  async resendVerification(@CurrentUser() user: UserIdentity): Promise<void> {
    await this.service.resendVerification(user.userId);
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(CurrentUserGuard)
  async changePassword(
    @CurrentUser() user: UserIdentity,
    @Body() request: ChangePasswordRequestDto,
  ): Promise<void> {
    await this.service.changePassword(
      user.userId,
      user.sessionId,
      request.currentPassword,
      request.newPassword,
    );
  }

  @Get('me')
  @UseGuards(CurrentUserGuard)
  me(@CurrentUser() user: UserIdentity): {
    id: string;
    email: string | null;
    emailVerified: boolean;
  } {
    return { id: user.userId, email: user.email, emailVerified: user.emailVerified };
  }

  private clientIp(http: Request): string {
    return clientAddress(
      http.headers['x-forwarded-for'],
      http.socket.remoteAddress,
      this.config.auth.trustedProxyHops,
    );
  }
}
