import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  UInt64,
  Permissions,
  isReady,
  shutdown,
  Signature,
  Bool,
  UInt32,
} from 'snarkyjs';
import { getTestContext, MINA, TEST_TIMEOUT } from '../test_utils';
import {
  AdminPermitWithSign,
  TokenManageEvent,
  TokenTransferEvent,
} from './model';
import { TOKEN_SYMBOL, TokenContract } from './token_contract';

describe('TokenContract E2E testing', () => {
  const ctx = getTestContext();

  async function deployToken(
    tokenContract: TokenContract,
    tokenContractKey: PrivateKey,
    feePayerKey: PrivateKey,
    initialFundAddress: PublicKey,
    initialFundTokenAmount: bigint
  ): Promise<void> {
    console.log('deploying token contract...');
    const feePayerAddress = feePayerKey.toPublicKey();
    let tx = await Mina.transaction(
      {
        sender: feePayerAddress,
        fee: ctx.txFee,
        memo: 'Deploying token',
      },
      () => {
        AccountUpdate.fundNewAccount(feePayerAddress, 2);

        tokenContract.deployToken(
          { zkappKey: tokenContractKey },
          {
            address: initialFundAddress,
            amount: UInt64.from(initialFundTokenAmount),
          }
        );
      }
    );

    await ctx.submitTx(tx, {
      feePayerKey,
      contractKeys: [tokenContractKey],
      logLabel: 'deploy token',
    });
  }

  beforeAll(async () => {
    await isReady;

    if (ctx.proofsEnabled) {
      console.log('start compiling contract...');

      console.time('TokenContract compile');
      let tokenVerificationKey = (await TokenContract.compile())
        .verificationKey;
      console.timeEnd('TokenContract compile');
      console.log(
        'TokenContract VerificationKey: ',
        JSON.stringify(tokenVerificationKey)
      );
    }
    await ctx.initMinaNetwork();
  }, TEST_TIMEOUT);

  afterAll(() => {
    setInterval(shutdown, 0);
  });

  it(
    `Token basic feature test - deployToBerkeley: ${ctx.deployToBerkeley}`,
    async () => {
      let feePayerKey: PrivateKey;
      let feePayerAddress: PublicKey;
      let callerAKey: PrivateKey;
      let callerAAddress: PublicKey;
      let callerBKey: PrivateKey;
      let callerBAddress: PublicKey;
      let callerCKey: PrivateKey;
      let callerCAddress: PublicKey;

      let tokenContractKey: PrivateKey;
      let tokenContractAddress: PublicKey;
      let tokenContract: TokenContract;
      let tokenId: Field;

      feePayerKey = await ctx.getFundedAccountForTest(
        BigInt(5 * MINA),
        'token'
      );
      feePayerAddress = feePayerKey.toPublicKey();
      callerAKey = PrivateKey.random();
      callerAAddress = callerAKey.toPublicKey();
      callerBKey = PrivateKey.random();
      callerBAddress = callerBKey.toPublicKey();
      callerCKey = PrivateKey.random();
      callerCAddress = callerCKey.toPublicKey();

      tokenContractKey = PrivateKey.random();
      tokenContractAddress = tokenContractKey.toPublicKey();
      tokenContract = new TokenContract(tokenContractAddress);
      tokenId = tokenContract.token.id;
      console.log('tokenId: ', tokenId.toString());

      console.log(`Use the following addresses to test:
    feePayer: ${feePayerAddress.toBase58()}
    token contract: ${tokenContractAddress.toBase58()}
    callerA: ${callerAAddress.toBase58()}
    callerB: ${callerBAddress.toBase58()}
    callerC: ${callerCAddress.toBase58()}`);

      //------------Deploy contracts-------------
      let initialFundTokenAmount = 1000n;
      let initialFundAddress = callerCAddress;
      await deployToken(
        tokenContract,
        tokenContractKey,
        feePayerKey,
        initialFundAddress,
        initialFundTokenAmount
      );

      let tokenContractAccount = await ctx.getAccount(tokenContractAddress);
      // Check contract accounts exists in the ledger
      expect(tokenContractAccount).toBeDefined();
      expect(tokenContractAccount.tokenSymbol).toEqual(TOKEN_SYMBOL);
      expect(tokenContractAccount.zkapp?.zkappUri).toEqual(
        'https://github.com/Comdex/mina-zkapps-e2e-testing'
      );
      expect(tokenContractAccount.permissions.editState).toEqual(
        Permissions.proof()
      );
      expect(tokenContractAccount.permissions.setTokenSymbol).toEqual(
        Permissions.proofOrSignature()
      );
      expect(tokenContractAccount.permissions.incrementNonce).toEqual(
        Permissions.proof()
      );
      expect(tokenContractAccount.permissions.setTiming).toEqual(
        Permissions.proof()
      );
      expect(tokenContractAccount.permissions.setDelegate).toEqual(
        Permissions.proof()
      );

      let callerCAccount = await ctx.getAccount(callerCAddress, tokenId);
      expect(callerCAccount.balance.toBigInt()).toEqual(initialFundTokenAmount);

      //------------Mint tokens-----------------------
      // Minting tokens should succeed
      const tokenMintAmount = 10000n;
      let adminNonce = await (await ctx.getAccount(tokenContractAddress)).nonce;
      let permitWithSign = AdminPermitWithSign.create({
        receiver: callerAAddress,
        amount: UInt64.from(tokenMintAmount),
        adminNonce,
        adminKey: tokenContractKey,
      });

      console.log('minting tokens...');
      let tx = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Minting tokens',
        },
        () => {
          AccountUpdate.fundNewAccount(feePayerAddress, 1);
          tokenContract.mint(permitWithSign);
        }
      );
      await ctx.submitTx(tx, {
        feePayerKey,
        contractKeys: [tokenContractKey],
        logLabel: 'mint tokens',
      });

      let callerA = await ctx.getAccount(callerAAddress, tokenId);
      expect(callerA.balance.toBigInt()).toEqual(tokenMintAmount);

      //------------Burn tokens-----------------------
      // Burning tokens should succeed
      const tokenBurnAmount = 5000n;
      console.log('burning tokens...');
      tx = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Burning tokens',
        },
        () => {
          tokenContract.burn(callerAAddress, UInt64.from(tokenBurnAmount));
        }
      );
      await ctx.submitTx(tx, {
        feePayerKey,
        contractKeys: [tokenContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'burn tokens',
      });

      let callerAAccount = await ctx.getAccount(callerAAddress, tokenId);
      expect(callerAAccount.balance.toBigInt()).toEqual(
        tokenMintAmount - tokenBurnAmount
      );

      //------------Transfer tokens-----------------------
      const tokenTransferAmount = 50n;
      tx = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Transfering tokens',
        },
        () => {
          AccountUpdate.fundNewAccount(feePayerAddress, 1);
          tokenContract.transfer(
            callerAAddress,
            callerBAddress,
            UInt64.from(tokenTransferAmount)
          );
        }
      );

      await ctx.submitTx(tx, {
        feePayerKey,
        contractKeys: [tokenContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'transfer tokens',
      });

      let callerBAccount = await ctx.getAccount(callerBAddress, tokenId);
      expect(callerBAccount.balance.toBigInt()).toEqual(tokenTransferAmount);

      //-----------------check events-------------------
      let events = await tokenContract.fetchEvents();
      console.log('events', events);
      expect(events.length).toEqual(4);

      // wait for next block
      // In order to prevent factors such as network delay and node processing delay, wait for a block before getting events
      await ctx.waitForBlock();

      expect(events[0].event).toEqual(
        new TokenManageEvent({
          receiver: initialFundAddress,
          amount: UInt64.from(initialFundTokenAmount),
        })
      );

      expect(events[1].event).toEqual(
        new TokenManageEvent({
          receiver: callerAAddress,
          amount: UInt64.from(tokenMintAmount),
        })
      );

      expect(events[2].event).toEqual(
        new TokenManageEvent({
          receiver: callerAAddress,
          amount: UInt64.from(tokenBurnAmount),
        })
      );

      expect(events[3].event).toEqual(
        new TokenTransferEvent({
          sender: callerAAddress,
          receiver: callerBAddress,
          amount: UInt64.from(tokenTransferAmount),
        })
      );
    },
    TEST_TIMEOUT
  );

  it(
    `Exchange tokens, set time-locked vault and update delegate - deployToBerkeley: ${ctx.deployToBerkeley}`,
    async () => {
      let feePayerKey: PrivateKey;
      let feePayerAddress: PublicKey;
      let callerAKey: PrivateKey;
      let callerAAddress: PublicKey;
      let callerBKey: PrivateKey;
      let callerBAddress: PublicKey;
      let callerCKey: PrivateKey;
      let callerCAddress: PublicKey;

      let tokenContractKey: PrivateKey;
      let tokenContractAddress: PublicKey;
      let tokenContract: TokenContract;
      let tokenId: Field;

      feePayerKey = await ctx.getFundedAccountForTest(
        BigInt(4 * MINA),
        'token2'
      );
      feePayerAddress = feePayerKey.toPublicKey();
      callerAKey = PrivateKey.random();
      callerAAddress = callerAKey.toPublicKey();
      callerBKey = PrivateKey.random();
      callerBAddress = callerBKey.toPublicKey();
      callerCKey = PrivateKey.random();
      callerCAddress = callerCKey.toPublicKey();

      tokenContractKey = PrivateKey.random();
      tokenContractAddress = tokenContractKey.toPublicKey();
      tokenContract = new TokenContract(tokenContractAddress);
      tokenId = tokenContract.token.id;
      console.log('tokenId: ', tokenId.toString());

      console.log(`Use the following addresses to test:
  feePayer: ${feePayerAddress.toBase58()}
  token contract: ${tokenContractAddress.toBase58()}
  callerA: ${callerAAddress.toBase58()}
  callerB: ${callerBAddress.toBase58()}
  callerC: ${callerCAddress.toBase58()}`);

      //------------Deploy contracts-------------
      let initialFundTokenAmount = 1000n;
      await deployToken(
        tokenContract,
        tokenContractKey,
        feePayerKey,
        callerCAddress,
        initialFundTokenAmount
      );

      let tokenContractAccount = await ctx.getAccount(tokenContractAddress);
      expect(tokenContractAccount.permissions.setTiming).toEqual(
        Permissions.proof()
      );
      expect(tokenContractAccount.permissions.setDelegate).toEqual(
        Permissions.proof()
      );
      let callerCAccount = await ctx.getAccount(callerCAddress, tokenId);
      expect(callerCAccount.balance.toBigInt()).toEqual(initialFundTokenAmount);

      //------------exchange tokens by mina-----------------------
      const exchangeTokenAmount = 300n;
      const minaToSpend = BigInt(3 * MINA);
      console.log('exchange tokens by mina...');
      let tx = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Exchagne tokens',
        },
        () => {
          // No need to fund new account here, callerC already funded
          tokenContract.exchangeTokensByMina(
            feePayerAddress,
            callerCAddress,
            UInt64.from(exchangeTokenAmount)
          );
        }
      );
      await ctx.submitTx(tx, {
        feePayerKey,
        contractKeys: [tokenContractKey],
        logLabel: 'exchange tokens',
      });

      tokenContractAccount = await ctx.getAccount(tokenContractAddress);
      expect(tokenContractAccount.balance.toBigInt()).toEqual(minaToSpend);
      callerCAccount = await ctx.getAccount(callerCAddress, tokenId);
      expect(callerCAccount.balance.toBigInt()).toEqual(
        initialFundTokenAmount + exchangeTokenAmount
      );

      //------------set time-locked vault-----------------------
      let globalSlotSinceGenesis = (await ctx.getNetworkStatus())
        .globalSlotSinceGenesis;
      let amountToLock = UInt64.from(minaToSpend);
      let cliffTime = globalSlotSinceGenesis.add(3); // lock 3 slots
      let adminSign = Signature.create(
        tokenContractKey,
        amountToLock.toFields().concat(cliffTime.toFields())
      );
      let tx2 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'timeLockVault',
        },
        () => {
          tokenContract.setTimeLockedVault(amountToLock, cliffTime, adminSign);
        }
      );
      await ctx.submitTx(tx2, {
        feePayerKey,
        contractKeys: [tokenContractKey],
        logLabel: 'timeLockVault',
      });

      let contractAccount = await ctx.getAccount(tokenContractAddress);
      expect(contractAccount.timing.isTimed).toEqual(Bool(true));
      expect(contractAccount.timing.cliffTime).toEqual(cliffTime);
      expect(contractAccount.timing.initialMinimumBalance).toEqual(
        amountToLock
      );
      expect(contractAccount.timing.cliffAmount).toEqual(amountToLock);
      expect(contractAccount.timing.vestingPeriod).toEqual(UInt32.from(1));
      expect(contractAccount.timing.vestingIncrement).toEqual(UInt64.from(0));

      //------------update delegate-----------------------
      // When the permission is Permissions.proof(), directly using the signature to update the delegate should fail
      let tx3 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'update delegate',
        },
        () => {
          tokenContract.account.delegate.set(callerAAddress);
        }
      );
      await ctx.submitTx(tx3, {
        feePayerKey,
        contractKeys: [tokenContractKey],
        otherSignKeys: [tokenContractKey],
        logLabel: 'use signature to update delegate',
      });
      tokenContractAccount = await ctx.getAccount(tokenContractAddress);
      // If the delegate of the contract is still itself, it means that the update failed
      expect(tokenContractAccount.delegate).toEqual(tokenContractAddress);

      // Using proof to update the delegate should succeed
      let updateSign = Signature.create(
        tokenContractKey,
        callerAAddress.toFields()
      );
      let tx4 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'update delegate',
        },
        () => {
          tokenContract.updateDelegate(callerAAddress, updateSign);
        }
      );
      await ctx.submitTx(tx4, {
        feePayerKey,
        contractKeys: [tokenContractKey],
        logLabel: 'use proof to update delegate',
      });
      tokenContractAccount = await ctx.getAccount(tokenContractAddress);
      expect(tokenContractAccount.delegate).toEqual(callerAAddress);
    },
    TEST_TIMEOUT
  );
});
