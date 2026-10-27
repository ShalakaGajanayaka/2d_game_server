import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { User } from './user.entity';

@Entity('bet_history')
@Index(['userId', 'createdAt'])
export class BetHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column('decimal', { precision: 18, scale: 6 })
  betAmount: number;

  @Column('decimal', { precision: 8, scale: 2, nullable: true })
  cashOutMultiplier: number | null;

  @Column('decimal', { precision: 8, scale: 2 })
  crashPoint: number;

  @Column('decimal', { precision: 18, scale: 6, default: 0 })
  winAmount: number;

  @Column({ default: 'USD', length: 10 })
  currency: string;

  @CreateDateColumn()
  createdAt: Date;
}
