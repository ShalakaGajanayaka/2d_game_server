import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { User } from './user.entity';

export enum DepositStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity('deposit_requests')
@Index(['status', 'createdAt'])
export class DepositRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Index()
  @Column()
  username: string;

  @Column({ nullable: true })
  email?: string;

  @Column('decimal', { precision: 12, scale: 2 })
  amount: number;

  @Column({ default: 'USD', length: 10 })
  currency: string;

  @Column()
  paymentMethod: string; // 'ipay', 'upay', 'bank_transfer'

  @Index({ unique: true })
  @Column({ unique: true })
  referenceNumber: string;

  @Index()
  @Column({ default: DepositStatus.PENDING })
  status: string;

  @Column({ nullable: true })
  adminNote?: string;

  @Column({ nullable: true })
  approvedBy?: string;

  @Column({ nullable: true, type: 'timestamp' })
  approvedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
