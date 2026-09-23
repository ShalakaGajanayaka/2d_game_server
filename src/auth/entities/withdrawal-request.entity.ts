import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum WithdrawalStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  REJECTED = 'REJECTED',
}

@Entity('withdrawal_requests')
export class WithdrawalRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Index()
  @Column()
  username: string;

  @Column({ nullable: true })
  email?: string;

  @Column('decimal', { precision: 12, scale: 2 })
  amount: number;

  @Column({ default: 'LKR' })
  currency: string;

  @Column()
  method: string; // 'bank_transfer' | 'ipay' | 'upay'

  @Column('text')
  payoutDetails: string; // JSON string with bank name, acc no, branch, mobile, holder name

  @Index()
  @Column({
    type: 'enum',
    enum: WithdrawalStatus,
    default: WithdrawalStatus.PENDING,
  })
  status: WithdrawalStatus;

  @Column({ nullable: true })
  adminNote?: string;

  @Column({ nullable: true })
  processedBy?: string;

  @Column({ nullable: true })
  processedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
