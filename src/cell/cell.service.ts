/// <reference types="@nervosnetwork/ckb-types" />
import { Injectable, HttpService } from '@nestjs/common';
import { map } from 'rxjs/operators';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import * as _ from 'lodash';
import * as Types from '../types';
import { Cell as CellEntity } from '../model/cell.entity';
import { Cell } from './interfaces/cell.interface';
import { configService } from '../config/config.service';
import { BlockService } from '../block/block.service';
import { AddressService } from '../address/address.service';
import { bigintStrToNum } from '../util/number';
import * as ckbUtils from '@nervosnetwork/ckb-sdk-utils';
import {CKB_TOKEN_DECIMALS} from '../util/constant';

@Injectable()
export class CellService {
  constructor(
    @InjectRepository(CellEntity) private readonly repo: Repository<CellEntity>,
    private readonly httpService: HttpService,
    private readonly blockService: BlockService,
    private readonly addressService: AddressService
  ) { }

  public async create(cell: Cell): Promise<Cell> {
    return await this.repo.save(cell)
  }

  public async getBalanceByAddress(address: string): Promise<number> {
    const queryObj = {
      address,
      status: 'live',
    }
    const liveCells = await this.repo.find(queryObj);

    if (liveCells.length === 0) return 0;

    const result = liveCells.reduce((pre, cur, index, arr) => {
      return pre + Number(cur.capacity)
    }, 0)

    return result;
  }


  public getTxHistories(params: Types.Indexer.QueryTxParams): Promise<any> {
    const { script, scriptType, order = 'desc', limit = '0x14' } = params;
    const payload = {
      id: 0,
      jsonrpc: "2.0",
      method: "get_transactions",
      params: [
        { script: script, 'script_type': scriptType },
        order,
        limit,
      ]
    }

    const observable = this.httpService.post(configService.CKB_INDEXER_ENDPOINT, payload)

    return observable.pipe(map(resp => {
      const txs = resp.data.result.objects
      console.log("txs num: ", txs.length);

      if (txs.length === 0) return [];
      const txsWithUniqueHash: Types.TxFromIndexer[] = _.uniqBy(txs, 'tx_hash');;
      return this.blockService.parseBlockTxs(txsWithUniqueHash)
    })).toPromise();

  }

  public getLiveCells(params: Types.Indexer.QueryTxParams): Promise<any> {
    const { script, scriptType, order = 'desc', limit = '0x14' } = params;

    const payload = {
      id: 0,
      jsonrpc: "2.0",
      method: "get_cells",
      params: [
        { script: script, 'script_type': scriptType },
        order,
        limit,
      ]
    }

    const observable = this.httpService.post(configService.CKB_INDEXER_ENDPOINT, payload)

    return observable.pipe(map(resp => {
      const liveCells = resp.data.result.objects
      console.log("liveCells num: ", liveCells.length);

      if (liveCells.length === 0) return [];
      return liveCells
    })).toPromise();

  }

  public async getUnspentCells(lockHash: string, isEmpty: boolean, capacity?: number) {

    const queryObj = {
        lockHash,
        typeCodeHash: null,
        status: 'live'
    };

    if(isEmpty){
      queryObj['outputData'] = '0x'
    }

    if (capacity == 0) {
      return []
    }

    const fakeFee = 1 * CKB_TOKEN_DECIMALS
    const ckbcapacity = capacity * CKB_TOKEN_DECIMALS
    const _totalcapacity = await this.addressService.getAddressInfo(lockHash)
    const totalcapacity = BigInt(_totalcapacity.capacity)

    if (totalcapacity < ckbcapacity) { // 余额不足
      return []
    }

    const sendCapactity = ckbcapacity + 61 * CKB_TOKEN_DECIMALS + fakeFee
    let unspentCells = []
    const cell = await this.repo.createQueryBuilder('cell')
    .where(queryObj)
    .andWhere('cell.capacity >:sendCapactity', {
      sendCapactity: sendCapactity
    }).getOne()

    if (cell) {
      unspentCells.push(cell)
    } else {
      const cells = await this.repo.createQueryBuilder('cell').where(queryObj).orderBy('cell.capacity', 'DESC').limit(10)
      unspentCells = await cells.getMany()

      const sumCapacity = unspentCells.reduce((pre, cur) => {
        return pre + BigInt(cur.capacity)
      }, BigInt(0))

      if (sumCapacity < sendCapactity) { // 小于
        unspentCells = await this.repo.find(queryObj)
      }
    }

    if (unspentCells.length === 0) {
      return []
    }

    const newUnspentCells = []

    for (const cell of unspentCells) {
      const dataLength = ckbUtils.hexToBytes(cell.outputData).length;
      const newCell = {
        "blockHash": cell.blockHash,
        "lock": {
          "codeHash": cell.lockCodeHash,
          "hashType": cell.lockHashType,
          "args": cell.lockArgs
        },
        "outPoint": {
          "txHash": cell.txHash,
          "index": cell.index,
        },
        "outputData": cell.outputData,
        "outputDataLen": '0x' + dataLength.toString(16),
        "capacity": "0x"+(bigintStrToNum(cell.capacity.toString()).toString(16)),
        "type": null,
        "dataHash": cell.outputDataHash,
        "status": cell.status,
      }
      newUnspentCells.push(newCell)
    }

    return newUnspentCells
  }
}
