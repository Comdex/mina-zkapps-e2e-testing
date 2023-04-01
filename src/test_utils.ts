import {
  fetchAccount,
  fetchLastBlock,
  Field,
  Mina,
  PublicKey,
  UInt32,
  Types,
  isReady,
  PrivateKey,
} from 'snarkyjs';
import fs from 'fs';
import config from '../config.json';

export { TestContext, getTestContext, TEST_TIMEOUT, MINA };

const MINA = 1e9;
const TEST_TIMEOUT = 1000 * 60 * 120;
const DEFAULT_TX_FEE = 0.01 * MINA;
const KEYS_DIR = 'keys';
const KEY_FILE_PREFIX = 'berkeley_';
// https://berkeley.minascan.io/graphql  https://proxy.berkeley.minaexplorer.com/graphql
// const MINA_GRAPHQL_URL = 'https://berkeley.minascan.io/graphql';
// https://archive-node-api.p42.xyz/  https://archive.berkeley.minaexplorer.com/
// const MINA_ARCHIVE_NODE_URL = 'https://archive-node-api.p42.xyz/';

interface TestContext {
  deployToBerkeley: boolean;
  proofsEnabled: boolean;
  txFee: number;

  initMinaNetwork(): Promise<void>;
  getAccount(publicKey: PublicKey, tokenId?: Field): Promise<Types.Account>;
  getNetworkStatus(): Promise<any>;
  waitForBlock(blockHeight?: UInt32): Promise<void>;
  submitTx(
    tx: Mina.Transaction,
    params: {
      feePayerKey: PrivateKey;
      contractKeys?: PrivateKey[];
      otherSignKeys?: PrivateKey[];
      logLabel?: string;
    }
  ): Promise<void>;
  getFundedAccountForTest(
    amountToSpend: bigint,
    keyFileLabel: string
  ): Promise<PrivateKey>;
}

function getTestContext(onlySupportProof = false): TestContext {
  let deployToBerkeley = process.env.TEST_ON_BERKELEY === 'true' ?? false;
  let proofsEnabled = process.env.TEST_PROOFS_ENABLED === 'true' ?? true;
  if (onlySupportProof) {
    proofsEnabled = true;
  }

  let getAccount = async (publicKey: PublicKey, tokenId?: Field) => {
    if (deployToBerkeley) {
      await fetchAccount({
        publicKey,
        tokenId,
      });
    }
    return Mina.getAccount(publicKey, tokenId);
  };

  let initMinaNetwork = async () => {
    await isReady;

    let Blockchain;

    if (deployToBerkeley) {
      Blockchain = Mina.Network({
        mina: config.networks.berkeley.mina,
        archive: config.networks.berkeley.archive,
      });
      console.log('endpoint-mina: ', config.networks.berkeley.mina);
      console.log('endpoint-archive: ', config.networks.berkeley.archive);
    } else {
      Blockchain = Mina.LocalBlockchain({
        proofsEnabled,
        enforceTransactionLimits: true,
      });
    }

    Mina.setActiveInstance(Blockchain);
  };

  let getNetworkStatus = async () => {
    if (deployToBerkeley) {
      await fetchLastBlock();
      console.log('sync Remote Network status success');
    }

    console.log(
      'current network status: ',
      JSON.stringify(Mina.activeInstance.getNetworkState())
    );
    return Mina.activeInstance.getNetworkState();
  };

  let waitForBlock = async (blockHeight?: UInt32) => {
    let currentBlockHeight =
      Mina.activeInstance.getNetworkState().blockchainLength;
    console.log(`currentBlockHeight: ${currentBlockHeight.toString()}`);

    if (blockHeight === undefined) {
      blockHeight = currentBlockHeight.add(1);
      console.log('wait for next block...');
    }

    if (deployToBerkeley) {
      // Wait for the specified block height
      for (;;) {
        await getNetworkStatus();

        if (blockHeight.lessThanOrEqual(currentBlockHeight).toBoolean()) {
          break;
        }

        let blockGap = Number.parseInt(
          blockHeight.sub(currentBlockHeight).toString()
        );
        blockGap = blockGap == 0 ? 1 : blockGap;
        await new Promise((resolve) =>
          setTimeout(resolve, blockGap * 3 * 60 * 1000)
        );
      }
    } else {
      (Mina.activeInstance as any).setBlockchainLength(blockHeight);
    }

    console.log(
      'current network state: ',
      JSON.stringify(Mina.activeInstance.getNetworkState())
    );
  };

  let submitTx = async (
    tx: Mina.Transaction,
    params: {
      feePayerKey: PrivateKey;
      contractKeys?: PrivateKey[];
      otherSignKeys?: PrivateKey[];
      logLabel?: string;
    }
  ) => {
    let signKeys = [params.feePayerKey];
    if (proofsEnabled) {
      console.time('tx prove');
      await tx.prove();
      console.timeEnd('tx prove');
    } else {
      if (params.contractKeys !== undefined && params.contractKeys.length > 0) {
        signKeys = signKeys.concat(params.contractKeys);
      }
    }

    if (params.otherSignKeys !== undefined && params.otherSignKeys.length > 0) {
      signKeys = signKeys.concat(params.otherSignKeys);
    }
    console.log('tx fee: ', DEFAULT_TX_FEE);
    let txId = await tx.sign(signKeys).send();
    let logLabel =
      params.logLabel !== undefined ? params.logLabel + ' txId: ' : 'txId: ';
    console.log(logLabel, txId.hash());
    await txId.wait({ maxAttempts: 1000 });
  };

  let getFundedAccountForTest = async (
    amountToSpend: bigint,
    keyFileLabel: string
  ) => {
    let fundedKey: PrivateKey;
    let fundedAddress: PublicKey;

    if (deployToBerkeley) {
      fundedKey = getAccountFromBerkeleyJson(keyFileLabel);
      fundedAddress = fundedKey.toPublicKey();

      let fundedAccountBalance = 0n;
      try {
        let fundedAccount = await getAccount(fundedAddress);
        console.log(
          'feePayerAccount balance: ',
          fundedAccount.balance.toString()
        );
        fundedAccountBalance = fundedAccount.balance.toBigInt();
      } catch (err) {
        console.log(err);
      }

      if (fundedAccountBalance < amountToSpend) {
        console.log(
          'The balance of feePayerAccount is insufficient, it needs to be regenerated and receive funds...'
        );
        fundedKey = PrivateKey.random();
        fundedAddress = fundedKey.toPublicKey();
        await Mina.faucet(fundedAddress);
        writeAccountToBerkeleyJson(fundedKey, keyFileLabel);
        console.log('Generate account done and funds received');
      } else {
        console.log('FeePayerAccount already funded in Berkeley');
      }
    } else {
      let fundMINA = 50 * MINA;

      fundedKey = PrivateKey.random();
      fundedAddress = fundedKey.toPublicKey();
      console.log('add fund to local account');
      (Mina.activeInstance as any).addAccount(
        fundedAddress,
        fundMINA.toString()
      );
    }

    return fundedKey;
  };

  return {
    deployToBerkeley,
    proofsEnabled,
    txFee: DEFAULT_TX_FEE,
    initMinaNetwork,
    getAccount,
    waitForBlock,
    getNetworkStatus,
    submitTx,
    getFundedAccountForTest,
  };
}

type Keypair = {
  privateKey: string;
  publicKey: string;
};

function getAccountFromBerkeleyJson(keyFileLabel: string): PrivateKey {
  const keyFilePath = KEYS_DIR + '/' + KEY_FILE_PREFIX + keyFileLabel + '.json';
  if (fs.existsSync(keyFilePath)) {
    let keypair = JSON.parse(
      fs.readFileSync(keyFilePath).toString()
    ) as Keypair;
    return PrivateKey.fromBase58(keypair.privateKey);
  } else {
    let account = PrivateKey.random();
    writeAccountToBerkeleyJson(account, keyFileLabel);
    return account;
  }
}

function writeAccountToBerkeleyJson(account: PrivateKey, keyFileLabel: string) {
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR);
  }

  let keypair = {
    privateKey: account.toBase58(),
    publicKey: account.toPublicKey().toBase58(),
  };

  const keyFilePath = KEYS_DIR + '/' + KEY_FILE_PREFIX + keyFileLabel + '.json';
  fs.writeFileSync(keyFilePath, JSON.stringify(keypair));
}