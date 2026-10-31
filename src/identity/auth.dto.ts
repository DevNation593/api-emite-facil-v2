import { JsonString, Email, NotBlank, NotNull, Size } from '../common/bean-validation.js';

/** Límite generoso: las reglas de la contraseña las aplica el servicio, con un mensaje claro. */
const MAX_PASSWORD = 1024;
const MAX_TOKEN = 200;
const MAX_EMAIL = 254;

export class CredentialsDto {
  @JsonString()
  @NotBlank()
  @Email()
  @Size({ max: MAX_EMAIL })
  email!: string;

  @JsonString()
  @NotNull()
  @Size({ max: MAX_PASSWORD })
  password!: string;
}

export class RefreshRequestDto {
  @JsonString()
  @NotBlank()
  @Size({ max: MAX_TOKEN })
  refreshToken!: string;
}

export class LinkRequestDto {
  @JsonString()
  @NotBlank()
  @Size({ max: MAX_TOKEN })
  token!: string;
}

export class EmailRequestDto {
  @JsonString()
  @NotBlank()
  @Email()
  @Size({ max: MAX_EMAIL })
  email!: string;
}

export class ResetRequestDto {
  @JsonString()
  @NotBlank()
  @Size({ max: MAX_TOKEN })
  token!: string;

  @JsonString()
  @NotNull()
  @Size({ max: MAX_PASSWORD })
  newPassword!: string;
}

export class ChangePasswordRequestDto {
  @JsonString()
  @NotNull()
  @Size({ max: MAX_PASSWORD })
  currentPassword!: string;

  @JsonString()
  @NotNull()
  @Size({ max: MAX_PASSWORD })
  newPassword!: string;
}
