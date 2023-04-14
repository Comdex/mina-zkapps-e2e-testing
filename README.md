# Mina zkApps E2E testing: NFT and Custom Token

## NFT POC

### Desciption

This is a simple NFT POC zkApp that allows users to spend a certain amount of custom tokens to mint an NFT from a short phrase, supports minting and transfer of NFTs.

### Surface Areas

1- Recursion

2- Call stack composability

Call the transfer method of the token zkApp to charge the token fee

3- Actions

6- Pre-conditions (network): blockchainLength

7- Permissions

- URI

8- Deploy Smart Contract

### Runtime

berkeley: about 120 mins

local: about 35 mins

### Public Key and verification key - Berkeley Deployment

public key: B62qpogUmvYSBEPGmMkavvVu8xPX342PvcQJWvyXqNUfpPEysqqie4s

verification key: [nft_contract_verification_key.json](./nft_contract_verification_key.json)

---

## Custom Token

### Description

This is a simple custom token zkApp, which supports the basic features of minting, burning and transferring and the function of sales, allowing users to use mina to exchange custom tokens, and lock the mina vault in the contract account.

### Surface Areas

4- Events

5- Pre-conditions (account): nonce

7- Permissions

- URI

- set token symbol

- set timing

- set delegate

8- Deploy Smart Contract

9- Tokens

### Runtime

berkeley: about 110 mins

local: about 20 mins

### Public Key and verification key - Berkeley Deployment

public key:

B62qqCHZWiCZowNtjRUdXKa9Acf23FxLYaNMcejx2cvskwy6EDNzqLi

B62qjXcrwSw6ABGdz2GXh6PgTqCH5SJBPA8gJLRcTLowEZep7ZnejJt

verification key: [token_contract_verification_key.json](./token_contract_verification_key.json)

---

## How to build

```sh
npm run build
```

## How to run tests

```sh
# run tests locally
npm run test
# run tests on Berkeley, set TEST_ON_BERKELEY=true
# The tests will automatically deploy zkApps and fund the fee payer account
npm run test:berkeley
```

## How to run coverage

```sh
npm run coverage
```

## License

[Apache-2.0](LICENSE)
