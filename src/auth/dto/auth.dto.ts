import { IsString, IsNotEmpty, MinLength, MaxLength, Matches, IsOptional } from 'class-validator';

export class RegisterDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsNotEmpty({ message: 'Password is required' })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password must not exceed 128 characters' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).*$/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
  })
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;
}

export class LoginDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsNotEmpty({ message: 'Password is required' })
  @IsString()
  password: string;
}

export class RequestResetOtpDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class ResetPasswordDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsNotEmpty({ message: 'Verification code is required' })
  @IsString()
  @MinLength(6, { message: 'Verification code must be 6 digits' })
  @MaxLength(6, { message: 'Verification code must be 6 digits' })
  otp: string;

  @IsNotEmpty({ message: 'New password is required' })
  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters long' })
  @MaxLength(128, { message: 'New password must not exceed 128 characters' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).*$/, {
    message: 'New password must contain at least one uppercase letter, one lowercase letter, and one number',
  })
  newPassword: string;
}

export class RenameUserDto {
  @IsNotEmpty({ message: 'New username is required' })
  @IsString()
  @MinLength(3, { message: 'Username must be at least 3 characters long' })
  @MaxLength(30, { message: 'Username must not exceed 30 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'Username may only contain letters, numbers, underscores, and hyphens',
  })
  newUsername: string;
}
