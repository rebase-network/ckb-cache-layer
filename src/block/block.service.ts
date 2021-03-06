/// <reference types="@nervosnetwork/ckb-types" />
import * as ckbUtils from '@nervosnetwork/ckb-sdk-utils';
import * as _ from 'lodash';
import { Injectable } from '@nestjs/common';
import { Interval, NestSchedule } from 'nest-schedule';
import * as Types from '../types';
import { Block } from '../model/block.entity';
import { SyncStat } from '../model/syncstat.entity';
import { Cell } from '../model/cell.entity';
import { Address } from '../model/address.entity';
import { CkbService } from '../ckb/ckb.service';
import { bigintStrToNum } from '../util/number';
import { EMPTY_TX_HASH } from '../util/constant';
import { CellRepository } from '../cell/cell.repository';
import { AddressRepository } from '../address/address.repository';
import { BlockRepository } from './block.repository';
import { SyncstatRepository } from '../syncstat/syncstat.repository';

interface TAddressesCapacity {
  string?: number;
}

@Injectable()
export class BlockService extends NestSchedule {
  constructor(
    private readonly ckbService: CkbService,

    private readonly blockRepo: BlockRepository,
    private readonly cellRepo: CellRepository,
    private readonly addressRepo: AddressRepository,
    private readonly syncStatRepo: SyncstatRepository,

  ) {
    super();
  }

  private readonly ckb = this.ckbService.getCKB();
  private isSyncing = false;
  private timeCount = 0;

  getReadableCell(output) {
    const result = {};
    result['capacity'] = parseInt(output.capacity, 16);
    result['lockHash'] = ckbUtils.scriptToHash(output.lock);
    result['lockCodeHash'] = output.lock.codeHash;
    result['lockArgs'] = output.lock.args;
    result['lockHashType'] = output.lock.hashType;

    return result;
  }

  async parseBlockTxs(txs): Promise<Types.ReadableTx[]> {
    const newTxs = [];
    for (const tx of txs) {
      const newTx = {};

      newTx['hash'] = tx.tx_hash;
      if (tx.block_number) {
        newTx['blockNum'] = parseInt(tx.block_number, 16);
        const header = await this.ckb.rpc.getHeaderByNumber(tx.block_number);
        if (!header) continue;
        newTx['timestamp'] = parseInt(header.timestamp, 16);
      }

      // const txObj = await this.cellService.getTxByTxHash(tx.tx_hash)
      const txObj = (await this.ckb.rpc.getTransaction(tx.hash || tx.tx_hash))
        .transaction;

      const outputs = txObj.outputs;
      const inputs = txObj.inputs;

      const newInputs = [];

      for (const input of inputs) {
        const befTxHash = input.previousOutput.txHash;

        // cellbase
        if (befTxHash !== EMPTY_TX_HASH) {
          // 0x000......00000 是出块奖励，inputs为空，cellbase
          const befIndex = input.previousOutput.index;

          // const inputTxObj = await this.cellService.getTxByTxHash(befTxHash)
          const inputTxObj = (await this.ckb.rpc.getTransaction(befTxHash))
            .transaction;
          const output = inputTxObj.outputs[parseInt(befIndex, 16)];

          const newInput = this.getReadableCell(output);
          newInputs.push(newInput);
        }
      }

      newTx['inputs'] = newInputs;

      const newOutputs = [];

      for (const output of outputs) {
        const newOutput = this.getReadableCell(output);
        newOutputs.push(newOutput);
      }

      newTx['outputs'] = newOutputs;
      newTxs.push(newTx);
    }

    return newTxs;
  }

  /**
   * sync blocks from blockchain
   */
  @Interval(5000)
  async sync() {
    const tipNumStr = await this.ckb.rpc.getTipBlockNumber();
    const tipNum = parseInt(tipNumStr, 16);
    const syncStat = await this.syncStatRepo.findOne();
    const tipNumSynced = syncStat ? Number(syncStat.tip) : 0;

    // Already the newest, do not need to sync
    if (tipNumSynced >= tipNum || this.isSyncing) return;

    this.isSyncing = true;

    for (let i = tipNumSynced + 1; i <= tipNum; i++) {
      await this.updateBlockInfo(i);
    }

    this.isSyncing = false;
  }

  /**
   * fetch the specified block from CKB chain, extract data and then update database
   * @param height block number
   */
  async updateBlockInfo(height: number) {
    console.time('updateBlockInfo');

    const block = await this.ckb.rpc.getBlockByNumber(
      '0x' + height.toString(16),
    );

    const blockTxs = block.transactions;
    await this.createBlock(block, blockTxs.length);

    await this.updateTip(height);
    const readableTxs: Types.ReadableTx[] = await this.parseBlockTxs(blockTxs);
    await this.updateAddressCapacity(readableTxs);
    await this.updateCells(block);

    console.timeEnd('updateBlockInfo');
    console.log(`****************** End block ${height} ****************** `);
  }

  async getAddress(lockHash: string): Promise<Address> {
    return await this.addressRepo.findOne({ lockHash });
  }

  accuOutput = (
    previous: Types.LockhashCapacity | any,
    cell: Types.ReadableCell,
  ) => {
    const previousCapacity = _.get(
      previous[cell.lockHash],
      'capacity',
      BigInt(0),
    );

    const result = Object.assign(previous, {
      [cell.lockHash]: {
        capacity: BigInt(previousCapacity) + BigInt(cell.capacity),
        lockScript: {
          args: cell.lockArgs,
          hashType: cell.lockHashType,
          codeHash: cell.lockCodeHash,
        },
      },
    });

    return result;
  };

  accuInput = (previous: Types.LockhashCapacity, cell: Types.ReadableCell) => {
    const previousCapacity = _.get(
      previous[cell.lockHash],
      'capacity',
      BigInt(0),
    );
    const result = Object.assign(previous, {
      [cell.lockHash]: {
        capacity: BigInt(previousCapacity) - BigInt(cell.capacity),
        lockScript: {
          args: cell.lockArgs,
          hashType: cell.lockHashType,
          codeHash: cell.lockCodeHash,
        },
      },
    });

    return result;
  };

  getAddressesForUpdate = (txs: Types.ReadableTx[]) => {
    const addressesCapacity = {};

    txs.forEach((tx: Types.ReadableTx) => {
      tx.outputs.reduce(this.accuOutput, addressesCapacity);
      tx.inputs.reduce(this.accuInput, addressesCapacity);
    });

    return addressesCapacity;
  };

  async updateAddressCapacity(txs: Types.ReadableTx[]) {
    try {
      const addressesForUpdate = this.getAddressesForUpdate(txs);

      const addressesUpdater = Object.keys(addressesForUpdate).map(
        async lockHash => {
          const oldAddr: Address = await this.getAddress(lockHash);
          const oldCapacity = oldAddr ? BigInt(oldAddr.capacity) : BigInt(0);
          const newCapacity =
            oldCapacity + _.get(addressesForUpdate[lockHash], 'capacity');

          if (oldAddr) {
            await this.addressRepo.update(
              { id: oldAddr.id },
              { capacity: newCapacity },
            );
            return;
          }

          const newAddr = new Address();
          const { lockScript } = addressesForUpdate[lockHash];
          newAddr.capacity = newCapacity;
          newAddr.lockHash = lockHash;
          newAddr.lockArgs = lockScript.args;
          newAddr.lockCodeHash = lockScript.codeHash;
          newAddr.lockHashType = lockScript.hashType;
          await this.addressRepo.save(newAddr);
        },
      );

      await Promise.all(addressesUpdater);
    } catch (error) {
      console.log('===> err is: ', error);
    }
  }

  async updateCells(block: CKBComponents.Block) {
    const cellUpdater = block.transactions.map(async (tx, inx) => {
      tx.inputs.forEach(async (input: CKBComponents.CellInput) => {
        await this.killCell(input);
      });

      tx.outputs.forEach(
        async (output: CKBComponents.CellOutput, index: number) => {
          const outPoint: CKBComponents.OutPoint = {
            txHash: tx.hash,
            index: `0x${index.toString(16)}`,
          };
          const liveCell = await this.ckb.rpc.getLiveCell(outPoint, true);
          const outputData = tx.outputsData[index];
          await this.createCell(
            block.header,
            output,
            index,
            tx,
            outputData,
            liveCell,
          );
        },
      );
    });
    await Promise.all(cellUpdater);
  }

  async killCell(input: CKBComponents.CellInput) {
    const oldCellObj = {
      status: 'live',
      txHash: input.previousOutput.txHash,
      index: input.previousOutput.index,
    };
    const oldCell: Cell = await this.cellRepo.findOne(oldCellObj);
    if (oldCell && oldCell.status) {
      Object.assign(oldCell, {
        status: 'dead', // 查一下
      });
      await this.cellRepo.save(oldCell);
    }
  }

  async createBlock(block, txCount) {
    const header = block.header;

    const blockObj = {
      number: parseInt(header.number, 16),
      hash: header.hash,
      // epochNumber: parseInt(header.epoch, 16),
      // epochIndex: parseInt(header.nonce, 16),
      // epochLength: 0,
      timestamp: parseInt(header.timestamp, 16),
      transactionCount: txCount,
      dao: header.dao,
    };

    const newBlock: Block = new Block();
    Object.assign(newBlock, blockObj);
    await this.blockRepo.save(newBlock);
  }

  // TODO
  async createCell(header, output, index, tx, outputData, liveCell) {
    const findCellObj = {
      txHash: tx.hash,
      index: `0x${index.toString(16)}`,
      status: 'live',
      lockArgs: output.lock.args,
    };

    const existCell = await this.cellRepo.findOne(findCellObj);
    if (existCell) return;
    const newCell: Cell = new Cell();
    const lockScript = {
      args: output.lock.args,
      codeHash: output.lock.codeHash,
      hashType: output.lock.hashType,
    };
    const lockHash = ckbUtils.scriptToHash(lockScript);
    let typeHash = null;
    if(!_.isEmpty(output.type)){
        const typeScript = {
            args: output.type.args,
            codeHash: output.type.codeHash,
            hashType: output.type.hashType,
        };
        typeHash = ckbUtils.scriptToHash(typeScript);
    }
    const newCellObj = {
      blockNumber: parseInt(header.number, 16),
      blockHash: header.hash,
      timestamp: parseInt(header.timestamp, 16),
      txHash: tx.hash,
      index: `0x${index.toString(16)}`,
      status: 'live',
      lockHash: lockHash,
      lockArgs: output.lock.args,
      lockCodeHash: output.lock.codeHash,
      lockHashType: output.lock.hashType,
      typeHash: typeHash,
      typeArgs: output.type?.args,
      typeCodeHash: output.type?.codeHash,
      typeHashType: output.type?.hashType,
      capacity: bigintStrToNum(output.capacity),
      address: '', // TODO delete it
      outputData: outputData,
      outputDataHash: _.get(liveCell, 'cell.data.hash', '0x'),
    };

    Object.assign(newCell, newCellObj);

    await this.cellRepo.save(newCell);
  }

  /**
   * update last syncing block
   * @param tip block number
   */
  async updateTip(tip: number) {
    const statData = await this.syncStatRepo.findOne();
    if (statData) {
      statData.tip = tip;
      await this.syncStatRepo.update({ id: statData.id }, { tip });
      return;
    }
    const newData = this.syncStatRepo.create(
      Object.assign({}, statData, { tip }),
    );
    await this.syncStatRepo.save(newData);
  }

  /**
   * get the last syncing block info
   */
  async getLastestBlock(): Promise<SyncStat> {
    return await this.syncStatRepo.findOne();
  }
  /**
   * get the latest block header on CKB chain
   */
  async getTipBlockHeader(): Promise<CKBComponents.BlockHeader> {
    return await this.ckb.rpc.getTipHeader();
  }

  /**
   * get block info with block height
   * @param height block number
   *
   * @returns block info
   */
  async getBlockByNumber(height: number): Promise<CKBComponents.Block> {
    const hexHeight = '0x' + height.toString(16);
    return await this.ckb.rpc.getBlockByNumber(hexHeight);
  }

  /**
   * get the best transaction fee rate currently.
   */
  async getFeeRate(): Promise<CKBComponents.FeeRate> {
    let feeRate: CKBComponents.FeeRate = { feeRate: '1000' };
    try {
      feeRate = await this.ckb.rpc.estimateFeeRate('0x3');
    } catch (err) {
      // this.logger.error('estimateFeeRate error', err, BlockService.name);
      console.error('estimateFeeRate error', err, BlockService.name);
    }
    return feeRate;
  }

//   /**
//    * test ckb indexer
//    */
//   @Interval(1000)
//   async indexer() { 
//     this.timeCount = this.timeCount + 1;
//     console.log(/timeCount/, this.timeCount);
//     const lockHash ='0x2de45e0c29b3beeee3f7180d5d2e1c92f24a51f8191cd884e07080bc053d8356';
//     //   await this.ckb.rpc.deindexLockHash(lockHash);
//     const indexerStatus = await this.getIndexStatusByLockHash(lockHash);
//     if (!indexerStatus) {
//       await this.ckb.rpc.indexLockHash(lockHash, '0x0');
//     } else {
//       // console.log(/delete/,'delete');
//       // await this.ckb.rpc.deindexLockHash(lockHash);
//       return;
//     }
//   }

//  async getIndexStatusByLockHash(lockHash: string) {
//     const indexers = await this.ckb.rpc.getLockHashIndexStates();
//     const result = _.find(indexers, (indexer) => {
//       return indexer.lockHash === lockHash;
//     });
//     if (!_.isEmpty(result)) {
//       console.log(/indexer result/,result)
//       return true;
//     }
//     return false;
//   };
}
