import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  username: string;

  @Column()
  passwordHash: string;

  @Column('decimal', { precision: 12, scale: 2, default: 1000.0 })
  balance: number;

  @Column({ default: 0 })
  gamesPlayed: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0.0 })
  totalWon: number;

  @Column('decimal', { precision: 8, scale: 2, default: 1.0 })
  bestMultiplier: number;

  @Column({ default: 'USD', length: 10 })
  currency: string;

  @Column({ nullable: true })
  phoneNumber: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
