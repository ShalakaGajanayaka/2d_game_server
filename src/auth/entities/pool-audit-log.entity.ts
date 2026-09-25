import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('pool_audit_logs')
export class PoolAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ default: 'Admin' })
  adminUser: string;

  @Column()
  action: string; // 'TOP_UP' | 'PROFIT_SKIM' | 'SET_TARGET'

  @Column('decimal', { precision: 12, scale: 2 })
  previousAmount: number;

  @Column('decimal', { precision: 12, scale: 2 })
  newAmount: number;

  @Column('decimal', { precision: 12, scale: 2 })
  delta: number;

  @Column({ nullable: true })
  note?: string;

  @CreateDateColumn()
  createdAt: Date;
}
