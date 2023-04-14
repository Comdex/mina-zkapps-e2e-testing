import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  UInt64,
  Permissions,
  shutdown,
  Signature,
  Bool,
  UInt32,
  Circuit,
  Poseidon,
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
    await ctx.initMinaNetwork();

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
  }, TEST_TIMEOUT);

  afterAll(() => {
    setInterval(shutdown, 1000);
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
      let totalAmountInCirculation = tokenContract.totalAmountInCirculation
        .get()
        .toBigInt();
      expect(totalAmountInCirculation).toEqual(initialFundTokenAmount);

      let callerCAccount = await ctx.getAccount(callerCAddress, tokenId);
      expect(callerCAccount.balance.toBigInt()).toEqual(initialFundTokenAmount);

      // In order to ensure that events can be obtained, try to wait for 2 blocks
      await ctx.waitForBlock();
      await ctx.waitForBlock();
      let events = await tokenContract.fetchEvents();
      console.log('after deploy - events: ', JSON.stringify(events));
      expect(events.length).toEqual(1);

      expect(
        events.filter((e) => {
          return e.type === 'mint';
        })[0].event.data
      ).toEqual(
        new TokenManageEvent({
          receiver: initialFundAddress,
          amount: UInt64.from(initialFundTokenAmount),
        })
      );

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

      if (ctx.deployToBerkeley) {
        await ctx.getAccount(tokenContractAddress);
      }
      let totalAmountInCirculationAfterMint =
        tokenContract.totalAmountInCirculation.get();
      totalAmountInCirculation = totalAmountInCirculation + tokenMintAmount;
      expect(totalAmountInCirculationAfterMint?.toBigInt()).toEqual(
        totalAmountInCirculation
      );

      await ctx.waitForBlock();
      await ctx.waitForBlock();
      events = await tokenContract.fetchEvents();
      console.log('after mint - events: ', JSON.stringify(events));
      expect(events.length).toEqual(2);

      expect(
        events.filter((e) => {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const eHash = Poseidon.hash(TokenManageEvent.toFields(e.event.data));
          const expectedHash = Poseidon.hash(
            TokenManageEvent.toFields(
              new TokenManageEvent({
                receiver: callerAAddress,
                amount: UInt64.from(tokenMintAmount),
              })
            )
          );
          return e.type === 'mint' && eHash.equals(expectedHash).toBoolean();
        })
      ).toHaveLength(1);

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

      if (ctx.deployToBerkeley) {
        await ctx.getAccount(tokenContractAddress);
      }
      let totalAmountInCirculationAfterBurn =
        tokenContract.totalAmountInCirculation.get();
      totalAmountInCirculation = totalAmountInCirculation - tokenBurnAmount;
      expect(totalAmountInCirculationAfterBurn?.toBigInt()).toEqual(
        totalAmountInCirculation
      );

      await ctx.waitForBlock();
      await ctx.waitForBlock();
      events = await tokenContract.fetchEvents();
      console.log('after burn - events: ', JSON.stringify(events));
      expect(events.length).toEqual(3);

      expect(
        events.filter((e) => {
          return e.type === 'burn';
        })[0].event.data
      ).toEqual(
        new TokenManageEvent({
          receiver: callerAAddress,
          amount: UInt64.from(tokenBurnAmount),
        })
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

      await ctx.waitForBlock();
      await ctx.waitForBlock();
      events = await tokenContract.fetchEvents();
      console.log('after transfer - events: ', JSON.stringify(events));
      expect(events.length).toEqual(4);

      expect(
        events.filter((e) => {
          return e.type === 'transfer';
        })[0].event.data
      ).toEqual(
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
      let cliffTime = globalSlotSinceGenesis.add(20); // lock 20 slots
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
      try {
        let tx3 = await Mina.transaction(
          {
            sender: feePayerAddress,
            fee: ctx.txFee,
            memo: 'update delegate',
          },
          () => {
            AccountUpdate.attachToTransaction(tokenContract.self);
            tokenContract.account.delegate.set(callerAAddress);
          }
        );
        await ctx.submitTx(tx3, {
          feePayerKey,
          contractKeys: [tokenContractKey],
          otherSignKeys: [tokenContractKey],
          logLabel: 'use signature to update delegate',
        });
      } catch (err) {
        console.log('As Expected, updating delegate should fail: ', err);
      }
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
