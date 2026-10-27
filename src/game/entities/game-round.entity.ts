import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('game_rounds')
@Index(['roomType', 'roundNumber'])
@Index(['createdAt'])
export class GameRound {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ length: 20 })
  roomType: string;

  @Column('bigint')
  roundNumber: number;

  @Column('decimal', { precision: 8, scale: 2 })
  crashPoint: number;

  @Column()
  serverSeed: string;

  @Column()
  serverSeedHash: string;

  @Column()
  clientSeed: string;

  @CreateDateColumn()
  createdAt: Date;
}
