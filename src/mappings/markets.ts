/* eslint-disable prefer-const */ // to satisfy AS compiler

// For each division by 10, add one to exponent to truncate one significant figure
import { Address, BigDecimal, BigInt, log } from '@graphprotocol/graph-ts'
import { Market, Comptroller } from '../types/schema'
import { PriceOracle2 } from '../types/templates/VToken/PriceOracle2'
import { BEP20 } from '../types/templates/VToken/BEP20'
import { VToken } from '../types/templates/VToken/VToken'

import {
  exponentToBigDecimal,
  mantissaFactor,
  mantissaFactorBD,
  vTokenDecimalsBD,
  zeroBD,
} from './helpers'

let vUSDCAddress = '0xeca88125a5adbe82614ffc12d0db554e2e2867c8'
let vBNBAddress = '0xa07c5b74c9b40447a954e1466938b865b6bbea36'

// Used for all vBEP20 contracts
function getTokenPrice(
  blockNumber: i32,
  eventAddress: Address,
  underlyingAddress: Address,
  underlyingDecimals: i32,
): BigDecimal {
  let comptroller = Comptroller.load('1')
  let oracleAddress = comptroller.priceOracle as Address
  let underlyingPrice: BigDecimal

  /* PriceOracle2 is used from starting of Comptroller.
   * This must use the vToken address.
   *
   * Note this returns the value without factoring in token decimals and wei, so we must divide
   * the number by (bnbDecimals - tokenDecimals) and again by the mantissa.
   */
  let mantissaDecimalFactor = 18 - underlyingDecimals + 18
  let bdFactor = exponentToBigDecimal(mantissaDecimalFactor)
  let oracle2 = PriceOracle2.bind(oracleAddress)
  underlyingPrice = oracle2
    .getUnderlyingPrice(eventAddress)
    .toBigDecimal()
    .div(bdFactor)

  return underlyingPrice
}

export function createMarket(marketAddress: string): Market {
  let market: Market
  let contract = VToken.bind(Address.fromString(marketAddress))

  // It is vBNB, which has a slightly different interface
  if (marketAddress == vBNBAddress) {
    market = new Market(marketAddress)
    market.underlyingAddress = Address.fromString(
      '0x0000000000000000000000000000000000000000',
    )
    market.underlyingDecimals = 18
    market.underlyingPrice = BigDecimal.fromString('1')
    market.underlyingName = 'Binance Coin'
    market.underlyingSymbol = 'BNB'
    market.underlyingPriceUSD = zeroBD
    // It is all other VBEP20 contracts
  } else {
    market = new Market(marketAddress)
    market.underlyingAddress = contract.underlying()
    let underlyingContract = BEP20.bind(market.underlyingAddress as Address)
    market.underlyingDecimals = underlyingContract.decimals()
    market.underlyingName = underlyingContract.name()
    market.underlyingSymbol = underlyingContract.symbol()
    market.underlyingPriceUSD = zeroBD
    market.underlyingPrice = zeroBD
    if (marketAddress == vUSDCAddress) {
      market.underlyingPriceUSD = BigDecimal.fromString('1')
    }
  }

  let interestRateModelAddress = contract.try_interestRateModel()
  let reserveFactor = contract.try_reserveFactorMantissa()

  market.borrowRate = zeroBD
  market.cash = zeroBD
  market.collateralFactor = zeroBD
  market.exchangeRate = zeroBD
  market.interestRateModelAddress = interestRateModelAddress.reverted
    ? Address.fromString('0x0000000000000000000000000000000000000000')
    : interestRateModelAddress.value
  market.name = contract.name()
  market.reserves = zeroBD
  market.supplyRate = zeroBD
  market.symbol = contract.symbol()
  market.totalBorrows = zeroBD
  market.totalSupply = zeroBD

  market.accrualBlockNumber = 0
  market.blockTimestamp = 0
  market.borrowIndex = zeroBD
  market.reserveFactor = reserveFactor.reverted ? BigInt.fromI32(0) : reserveFactor.value

  return market
}

function getBNBinUSD(blockNumber: i32): BigDecimal {
  let comptroller = Comptroller.load('1')
  let oracleAddress = comptroller.priceOracle as Address
  let oracle = PriceOracle2.bind(oracleAddress)
  let bnbPriceInUSD = oracle
    .getUnderlyingPrice(Address.fromString(vBNBAddress))
    .toBigDecimal()
    .div(mantissaFactorBD)
  return bnbPriceInUSD
}

export function updateMarket(
  marketAddress: Address,
  blockNumber: i32,
  blockTimestamp: i32,
): Market {
  let marketID = marketAddress.toHexString()
  let market = Market.load(marketID)
  if (market == null) {
    market = createMarket(marketID)
  }

  // Only updateMarket if it has not been updated this block
  if (market.accrualBlockNumber != blockNumber) {
    let contractAddress = Address.fromString(market.id)
    let contract = VToken.bind(contractAddress)

    let bnbPriceInUSD = getBNBinUSD(blockNumber)

    // if vBNB, we only update USD price
    if (market.id == vBNBAddress) {
      market.underlyingPriceUSD = bnbPriceInUSD.truncate(market.underlyingDecimals)
    } else {
      let tokenPriceUSD = getTokenPrice(
        blockNumber,
        contractAddress,
        market.underlyingAddress as Address,
        market.underlyingDecimals,
      )
      market.underlyingPrice = tokenPriceUSD
        .div(bnbPriceInUSD)
        .truncate(market.underlyingDecimals)
      // if USDC, we only update BNB price
      if (market.id != vUSDCAddress) {
        market.underlyingPriceUSD = tokenPriceUSD.truncate(market.underlyingDecimals)
      }
    }

    market.accrualBlockNumber = contract.accrualBlockNumber().toI32()
    market.blockTimestamp = blockTimestamp
    let totalSupply = contract.try_totalSupply()
    if (!totalSupply.reverted) {
      market.totalSupply = totalSupply.value.toBigDecimal().div(vTokenDecimalsBD)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_totalSupply',
        market.name,
      ])
    }

    /* Exchange rate explanation
       In Practice
        - If you call the vDAI contract on bscscan it comes back (2.0 * 10^26)
        - If you call the vUSDC contract on bscscan it comes back (2.0 * 10^14)
        - The real value is ~0.02. So vDAI is off by 10^28, and vUSDC 10^16
       How to calculate for tokens with different decimals
        - Must div by tokenDecimals, 10^market.underlyingDecimals
        - Must multiply by vtokenDecimals, 10^8
        - Must div by mantissa, 10^18
     */
    let exchangeRateStored = contract.try_exchangeRateStored()
    if (!exchangeRateStored.reverted) {
      market.exchangeRate = exchangeRateStored.value
        .toBigDecimal()
        .div(exponentToBigDecimal(market.underlyingDecimals))
        .times(vTokenDecimalsBD)
        .div(mantissaFactorBD)
        .truncate(mantissaFactor)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_exchangeRateStored',
        market.name,
      ])
    }
    let borrowIndex = contract.try_borrowIndex()
    if (!borrowIndex.reverted) {
      market.borrowIndex = borrowIndex.value
        .toBigDecimal()
        .div(mantissaFactorBD)
        .truncate(mantissaFactor)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_borrowIndex',
        market.name,
      ])
    }
    let totalReserves = contract.try_totalReserves()
    if (!totalReserves.reverted) {
      market.reserves = totalReserves.value
        .toBigDecimal()
        .div(exponentToBigDecimal(market.underlyingDecimals))
        .truncate(market.underlyingDecimals)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_totalReserves',
        market.name,
      ])
    }
    let totalBorrows = contract.try_totalBorrows()
    if (!totalBorrows.reverted) {
      market.totalBorrows = totalBorrows.value
        .toBigDecimal()
        .div(exponentToBigDecimal(market.underlyingDecimals))
        .truncate(market.underlyingDecimals)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_totalBorrows',
        market.name,
      ])
    }
    let getCash = contract.try_getCash()
    if (!getCash.reverted) {
      market.cash = getCash.value
        .toBigDecimal()
        .div(exponentToBigDecimal(market.underlyingDecimals))
        .truncate(market.underlyingDecimals)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_getCash',
        market.name,
      ])
    }
    let borrowRatePerBlock = contract.try_borrowRatePerBlock()
    if (!borrowRatePerBlock.reverted) {
      market.borrowRate = borrowRatePerBlock.value
        .toBigDecimal()
        .div(mantissaFactorBD)
        .truncate(mantissaFactor)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_borrowRatePerBlock',
        market.name,
      ])
    }
    let supplyRatePerBlock = contract.try_supplyRatePerBlock()
    if (!supplyRatePerBlock.reverted) {
      market.supplyRate = supplyRatePerBlock.value
        .toBigDecimal()
        .div(mantissaFactorBD)
        .truncate(mantissaFactor)
    } else {
      log.error('Contract call reverted! call_name: {}, market_name: {}', [
        'try_supplyRatePerBlock',
        market.name,
      ])
    }
    market.save()
  }
  return market as Market
}
