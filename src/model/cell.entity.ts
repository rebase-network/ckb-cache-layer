import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'cell' })
export class Cell {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'bigint' })
  blockNumber: number;

  @Column({ type: 'varchar' })
  blockHash: string;

  @Column('bigint')
  timestamp: number;

  @Column({ type: 'bigint' })
  capacity: number;

  @Column({ type: 'varchar' })
  address: string;

  // outPoint
  @Column({ type: 'varchar' })
  txHash: string;

  // outPoint
  @Column({ type: 'varchar' })
  index: string;

  @Column({ type: 'varchar' })
  status: string;

  @Column({ type: 'varchar' })
  lockArgs: string;

  @Column({ type: 'varchar' })
  lockCodeHash: string;

  @Column({ type: 'varchar' })
  lockHashType: string;

  @Column({ type: 'varchar', default: null, nullable: true } )
  typeArgs: string;

  @Column({ type: 'varchar', default: null, nullable: true } )
  typeCodeHash: string;

  @Column({ type: 'varchar', default: null, nullable: true } )
  typeHashType: string;

  @Column({ type: 'varchar' })
  outputData: string;

  @Column({ type: 'varchar' })
  outputDataHash: string;

}
