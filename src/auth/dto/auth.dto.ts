import {
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  Matches,
  IsOptional,
  IsInt,
  IsNumber,
  Min,
  Max,
  IsIn,
} from 'class-validator';

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
  @MaxLength(16, { message: 'Username must not exceed 16 characters' })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Username may only contain letters, numbers, and underscores',
  })
  newUsername: string;
}

export class PlaceGameBetDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsNotEmpty({ message: 'Bet slot index is required' })
  @IsInt({ message: 'Bet index must be an integer (1 or 2)' })
  @Min(1, { message: 'Bet slot index must be 1 or 2' })
  @Max(2, { message: 'Bet slot index must be 1 or 2' })
  betIndex: number;

  @IsNotEmpty({ message: 'Bet amount is required' })
  @IsNumber({}, { message: 'Bet amount must be a valid numeric value' })
  @Min(1.0, { message: 'Minimum bet amount is $1.00 USD' })
  @Max(500.0, { message: 'Maximum bet amount is $500.00 USD' })
  amount: number;

  @IsOptional()
  @IsNumber({}, { message: 'Auto-cashout multiplier must be a valid numeric value' })
  @Min(1.01, { message: 'Minimum auto-cashout multiplier is 1.01x' })
  @Max(10000.0, { message: 'Maximum auto-cashout multiplier is 10,000.00x' })
  autoCashout?: number | null;
}

export class CancelGameBetDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsNotEmpty({ message: 'Bet slot index is required' })
  @IsInt({ message: 'Bet index must be an integer (1 or 2)' })
  @Min(1, { message: 'Bet slot index must be 1 or 2' })
  @Max(2, { message: 'Bet slot index must be 1 or 2' })
  betIndex: number;

  @IsOptional()
  @IsString()
  @IsIn(['active', 'queued'], { message: 'Cancel target must be either "active" or "queued"' })
  target?: 'active' | 'queued';
}

export class CashoutGameBetDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsNotEmpty({ message: 'Bet slot index is required' })
  @IsInt({ message: 'Bet index must be an integer (1 or 2)' })
  @Min(1, { message: 'Bet slot index must be 1 or 2' })
  @Max(2, { message: 'Bet slot index must be 1 or 2' })
  betIndex: number;
}
