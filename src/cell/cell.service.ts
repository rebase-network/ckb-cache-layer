/// <reference types="@nervosnetwork/ckb-types" />
import { Injectable, HttpService } from '@nestjs/common';
import { map } from 'rxjs/operators';
import * as _ from 'lodash';
import * as Types from '../types';
import { Cell } from './interfaces/cell.interface';
import { configService } from '../config/config.service';
import { BlockService } from '../block/block.service';
import { AddressService } from '../address/address.service';
import { bigintStrToNum } from '../util/number';
import * as ckbUtils from '@nervosnetwork/ckb-sdk-utils';
import { CKB_TOKEN_DECIMALS } from '../util/constant';
import { CellRepository } from './cell.repository';
import { ApiException } from '../exception/api.exception';
import { ApiCode } from '../util/apiCode.enums';
import * as utils from '@nervosnetwork/ckb-sdk-utils';

@Injectable()
export class CellService {
  constructor(
    private cellRepository: CellRepository,
    private readonly httpService: HttpService,
    private readonly blockService: BlockService,
    private readonly addressService: AddressService,
  ) {}

  public async create(cell: Cell): Promise<Cell> {
    return await this.cellRepository.save(cell);
  }

  public async getBalanceByAddress(address: string): Promise<number> {
    const queryObj = {
      address,
      status: 'live',
    };
    const liveCells = await this.cellRepository.find(queryObj);

    if (liveCells.length === 0) return 0;
    const result = liveCells.reduce((pre, cur, index, arr) => {
      return pre + Number(cur.capacity);
    }, 0);

    return result;
  }

  public getTxHistories(params: Types.Indexer.QueryTxParams): Promise<any> {
    const { script, scriptType, order = 'desc', limit = '0x14' } = params;
    const payload = {
      id: 0,
      jsonrpc: '2.0',
      method: 'get_transactions',
      params: [{ script: script, script_type: scriptType }, order, limit],
    };
    const observable = this.httpService.post(
      configService.CKB_INDEXER_ENDPOINT,
      payload,
    );

    return observable
      .pipe(
        map(resp => {
          const txs = resp.data.result.objects;
          console.log('txs num: ', txs.length);

          if (txs.length === 0) return [];
          const txsWithUniqueHash: Types.TxFromIndexer[] = _.uniqBy(
            txs,
            'tx_hash',
          );
          return this.blockService.parseBlockTxs(txsWithUniqueHash);
        }),
      )
      .toPromise();
  }

  public getLiveCells(params: Types.Indexer.QueryTxParams): Promise<any> {
    const { script, scriptType, order = 'desc', limit = '0x14' } = params;

    const payload = {
      id: 0,
      jsonrpc: '2.0',
      method: 'get_cells',
      params: [{ script: script, script_type: scriptType }, order, limit],
    };

    const observable = this.httpService.post(
      configService.CKB_INDEXER_ENDPOINT,
      payload,
    );

    return observable
      .pipe(
        map(resp => {
          const liveCells = resp.data.result.objects;
          console.log('liveCells num: ', liveCells.length);

          if (liveCells.length === 0) return [];
          return liveCells;
        }),
      )
      .toPromise();
  }

  public async getUnspentCells(
    lockHash: string,
    isEmpty: boolean,
    capacity?: number,
  ) {
    console.time('getUnspentCells');
    const queryObj = {
      lockHash,
      typeCodeHash: null,
      status: 'live',
    };

    if (isEmpty) {
      queryObj['outputData'] = '0x';
    }

    if (capacity == 0) {
      return [];
    }

    const fakeFee = 1 * CKB_TOKEN_DECIMALS;
    const ckbcapacity = capacity * CKB_TOKEN_DECIMALS;
    const _totalcapacity = await this.addressService.getAddressInfo(lockHash);
    const totalcapacity = BigInt(_totalcapacity.capacity);

    if (totalcapacity < ckbcapacity) {
      // 余额不足
      //   throw new ServiceError('lack of capacity', '1001')
      throw new ApiException('lack of capacity', ApiCode.LACK_OF_CAPACITY, 200);
    }

    const sendCapactity = ckbcapacity + 61 * CKB_TOKEN_DECIMALS + fakeFee;
    let unspentCells = [];

    const cell = await this.cellRepository.queryByQueryObjAndCapacity(
      queryObj,
      sendCapactity,
    );

    if (cell) {
      unspentCells.push(cell);
    } else {
      let sumCapacity = 0;
      let page = 0;
      const step = 50;

      do {
        const cells = await this.cellRepository.queryByQueryObjAndStepPage(
          queryObj,
          step,
          page,
        );
        const newcells = await cells.getMany();
        unspentCells = _.concat(unspentCells, newcells);

        sumCapacity = unspentCells.reduce((pre, cur) => {
          return pre + BigInt(cur.capacity);
        }, BigInt(0));
        page += 1;
      } while (sumCapacity < sendCapactity);
    }

    if (unspentCells.length === 0) {
      return [];
    }

    const newUnspentCells = [];

    for (const cell of unspentCells) {
      const dataLength = ckbUtils.hexToBytes(cell.outputData).length;
      const newCell = {
        blockHash: cell.blockHash,
        lock: {
          codeHash: cell.lockCodeHash,
          hashType: cell.lockHashType,
          args: cell.lockArgs,
        },
        outPoint: {
          txHash: cell.txHash,
          index: cell.index,
        },
        outputData: cell.outputData,
        outputDataLen: '0x' + dataLength.toString(16),
        capacity: '0x' + bigintStrToNum(cell.capacity.toString()).toString(16),
        type: null,
        dataHash: cell.outputDataHash,
        status: cell.status,
      };
      newUnspentCells.push(newCell);
    }
    console.timeEnd('getUnspentCells');

    return newUnspentCells;
  }

  public async getCellsByLockHashAndTypeScripts(
    lockHash,
    typeScripts: CKBComponents.Script[],
  ) {
    const result = {};
    for (const typeScript of typeScripts) {
      const cells = await this.cellRepository.queryCellsByLockHashAndTypeScript(
        lockHash,
        typeScript.hashType,
        typeScript.codeHash,
        typeScript.args,
      );
      if (_.isEmpty(cells)) {
        return [];
      }
      const udts = [];
      for (const typeScriptCell of cells) {
        const typeScript: CKBComponents.Script = {
          args: typeScriptCell.typeArgs,
          codeHash: typeScriptCell.typeCodeHash,
          hashType: 'data',
        };
        const typeScriptHash = utils.scriptToHash(typeScript);
        const udt = {
          typeHash: typeScriptHash,
          capacity: typeScriptCell.capacity,
          outputdata: typeScriptCell.outputData,
          type: typeScript,
        };
        udts.push(udt);
      }
      result['udts'] = udts;
    }
    const freeCells = await this.cellRepository.queryFreeCellsByLockHash(
      lockHash,
    );
    function getTotalCapity(total, cell) {
      return BigInt(total) + BigInt(cell.capacity);
    }
    const totalFreeCapity = freeCells.reduce(getTotalCapity, 0);
    result['capacity'] = totalFreeCapity.toString();
    return result;
  }
}
