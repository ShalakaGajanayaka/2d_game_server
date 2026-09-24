import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('bet_history')
export class BetHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Column('decimal', { precision: 12, scale: 2 })
  betAmount: number;

  @Column('decimal', { precision: 8, scale: 2, nullable: true })
  cashOutMultiplier: number | null;

  @Column('decimal', { precision: 8, scale: 2 })
  crashPoint: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  winAmount: number;

  @Column({ default: 'USD', length: 10 })
  currency: string;

  @CreateDateColumn()
  createdAt: Date;
}
