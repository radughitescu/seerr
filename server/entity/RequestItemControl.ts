import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MediaRequest } from './MediaRequest';
import { User } from './User';

export type ControlState = 'paused' | 'deleted';

@Entity()
@Index(['request', 'seasonNumber', 'episodeNumber'], { unique: true })
export class RequestItemControl {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaRequest, (request) => request.controls, {
    onDelete: 'CASCADE',
  })
  @Index()
  public request: MediaRequest;

  @Column({ type: 'integer', nullable: true })
  public seasonNumber: number | null;

  @Column({ type: 'integer', nullable: true })
  public episodeNumber: number | null;

  @Column({ type: 'varchar' })
  public state: ControlState;

  @Column({ type: 'integer', nullable: true })
  public pausedAtPercent: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  public createdBy: User | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<RequestItemControl>) {
    Object.assign(this, init);
  }
}

export default RequestItemControl;
