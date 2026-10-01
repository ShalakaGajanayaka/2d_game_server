import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Column()
  type: string; // 'BET', 'CASHOUT', 'DEPOSIT'

  @Column('decimal', { precision: 18, scale: 6 })
  amount: number;

  @Column('decimal', { precision: 8, scale: 2, nullable: true })
  multiplier: number | null;

  @Column('decimal', { precision: 18, scale: 6 })
  balanceAfter: number;

  @Column({ default: 'USD', length: 10 })
  currency: string;

  @CreateDateColumn()
  createdAt: Date;
}
