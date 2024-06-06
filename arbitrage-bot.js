require('dotenv').config();
require('console.table');
const fs = require('fs');
const express = require('express');
const path = require('path');
const player = require('play-sound')(opts = {});
const http = require('http');
const cors = require('cors');
const Web3 = require('web3');
const axios = require('axios');
const moment = require('moment-timezone');
const _ = require('lodash');

const API_KEY_ETHGAS_PULSE = "db84e1509032bc4cc4f96d1c8791d92b667d28adc606bda9480c9a616310";

// SERVER CONFIG
const PORT = process.env.PORT || 5000;
const app = express();
const server = http.createServer(app).listen(PORT, () => console.log(`Listening on ${PORT}`));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ credentials: true, origin: '*' }));

// WEB3 CONFIG
const web3 = new Web3(process.env.RPC_URL);
web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

// SMART CONTRACTS
const ONE_SPLIT_ABI = [/*...ABI details...*/];
const ONE_SPLIT_ADDRESS = "0xC586BeF4a0992C495Cf22e1aeEE4E446CECDee0E";
const oneSplitContract = new web3.eth.Contract(ONE_SPLIT_ABI, ONE_SPLIT_ADDRESS);

const ERC_20_ABI = [/*...ABI details...*/];
const ZRX_EXCHANGE_ADDRESS = '0x61935CbDd02287B511119DDb11Aeb42F1593b7Ef';
const ZRX_EXCHANGE_ABI = [/*...ABI details...*/];
const zrxExchangeContract = new web3.eth.Contract(ZRX_EXCHANGE_ABI, ZRX_EXCHANGE_ADDRESS);

const TRADER_ABI = [/*...ABI details...*/];
const TRADER_ADDRESS = process.env.CONTRACT_ADDRESS;
const traderContract = new web3.eth.Contract(TRADER_ABI, TRADER_ADDRESS);
const FILL_ORDER_ABI = {/*...ABI details...*/};

// INITIALIZE VARIABLES
let myGasPrice2 = 0;
let myNumberOfCallsBot = 0;
let fetchingLoop = 0;
let totalOrders = 0;
let ordersMapStats = new Map();
let total0xCalls = 0;
let total0xCallsFailed = 0;
const startTimeBot = Math.floor(Date.now() / 1000);
const triangularArbThreeSteps = false;
const checkedOrders = [];
let profitableArbFound = false;

// ASSET SYMBOLS AND ADDRESSES
const ASSET_SYMBOLS = ['DAI', 'WETH', 'USDC', 'LINK', 'COMP', 'UMA', 'YFI', 'UNI', 'LEND', 'BAND', 'BAL', 'MKR', 'BUSD', 'OMG', 'TUSD', 'ZRX', 'BAT', 'NMR', 'PAX', 'KNC', 'REN', 'SNT', 'ENJ', 'ANT', 'AMPL', 'REPV2', 'KEEP', 'CRV', 'BNT', 'LPT', 'FOAM', 'BZRX', 'DONUT', 'SNX', 'GNO', 'SUSD', 'SAI', 'CVL', 'DTH', 'GEN', 'MANA', 'LOOM', 'SPANK', 'REQ', 'MATIC', 'LRC', 'RDN', 'SUSHI'];
const ASSET_ADDRESSES = {/*...Asset addresses...*/};

// DISPLAY LOGIC
const tokensWithDecimalPlaces = (amount, symbol) => web3.utils.fromWei(amount.toString(), 'Ether');
const TOKEN_DISPLAY_DECIMALS = 2;
const displayTokens = (amount, symbol) => tokensWithDecimalPlaces(amount, symbol);

// UTILITIES
const now = () => moment().tz(moment.tz.guess()).format();
const SOUND_FILE = 'ding.mp3';
const playSound = () => {
    player.play(SOUND_FILE, (err) => {
        if (err) console.log("Error playing sound!");
    });
};

// FORMATTERS
const toTokens = (tokenAmount, symbol) => web3.utils.toWei(tokenAmount, 'Ether');

// TRADING FUNCTIONS
const ONE_SPLIT_PARTS = 10;
const ONE_SPLIT_FLAGS = 0;
const fetchOneSplitData = async (args) => {
    const { fromToken, toToken, amount } = args;
    try {
        return await oneSplitContract.methods.getExpectedReturn(fromToken, toToken, amount, ONE_SPLIT_PARTS, ONE_SPLIT_FLAGS).call();
    } catch (error) {
        console.log('fetchOneSplitData problem!', error);
    }
};

const checkArb = async (args) => {
    const { assetOrder, zrxOrder } = args;
    const tempOrderID = JSON.stringify(zrxOrder);
    if (checkedOrders.length % 1000 === 0) checkedOrders = [];
    if (checkedOrders.includes(tempOrderID)) return;
    totalOrders++;
    ordersMapStats.set(assetOrder[1], (ordersMapStats.get(assetOrder[1]) || 0) + 1);
    checkedOrders.push(tempOrderID);
    if (zrxOrder.makerFee.toString() !== '0' || zrxOrder.takerFee.toString() !== '0') return;
    let inputAssetAmount = zrxOrder.takerAssetAmount;
    const orderTuple = [zrxOrder.makerAddress, zrxOrder.takerAddress, zrxOrder.feeRecipientAddress, zrxOrder.senderAddress, zrxOrder.makerAssetAmount, zrxOrder.takerAssetAmount, zrxOrder.makerFee, zrxOrder.takerFee, zrxOrder.expirationTimeSeconds, zrxOrder.salt, zrxOrder.makerAssetData, zrxOrder.takerAssetData, zrxOrder.makerFeeAssetData, zrxOrder.takerFeeAssetData];
    const orderInfo = await zrxExchangeContract.methods.getOrderInfo(orderTuple).call();
    if (orderInfo.orderTakerAssetFilledAmount.toString() !== '0') {
        inputAssetAmount -= orderInfo.orderTakerAssetFilledAmount;
        return;
    }
    let oneSplitData, outputAssetAmount;
    try {
        if (!triangularArbThreeSteps) {
            oneSplitData = await fetchOneSplitData({ fromToken: ASSET_ADDRESSES[assetOrder[1]], toToken: ASSET_ADDRESSES[assetOrder[2]], amount: zrxOrder.makerAssetAmount });
            outputAssetAmount = oneSplitData.returnAmount;
        }
    } catch (error) {
        console.log('calling fetchOneSplitData is the problem!', error);
    }
    myNumberOfCallsBot++;
    if (myGasPrice2 === 0 || myNumberOfCallsBot % 50 === 1) {
        const ethGasStationResponse = await axios.get(`https://data-api.defipulse.com/api/v1/egs/api/ethgasAPI.json?api-key=${API_KEY_ETHGAS_PULSE}`);
        const ethGasStationData = ethGasStationResponse.data;
        myGasPrice2 = Math.floor((ethGasStationData.fastest / 10) * 1.0);
    }
    if (myGasPrice2 === 0) myGasPrice2 = process.env.GAS_PRICE;
    const estimatedGasFee = process.env.ESTIMATED_GAS * web3.utils.toWei(myGasPrice2.toString(), 'Gwei');
    const netProfit = Math.floor(outputAssetAmount - inputAssetAmount - estimatedGasFee);
    const netProfitWithoutGas = Math.floor(outputAssetAmount - inputAssetAmount);
    const profitable = netProfit.toString() > '0';
    if (outputAssetAmount - inputAssetAmount > 1000000000000000) {
        console.table([{ 'Profitable?': profitable, 'Asset Order': assetOrder.join(', '), 'Exchange Order': 'ZRX, 1Split', 'Profit w/ Gas': web3.utils.fromWei(netProfitWithoutGas.toString(), 'Ether'), 'Input': displayTokens(inputAssetAmount, assetOrder[0]), 'Output': displayTokens(outputAssetAmount, assetOrder[0]), 'Profit': displayTokens(netProfit.toString(), assetOrder[0]), 'Maker Price:': web3.utils.fromWei(zrxOrder.makerAssetAmount.toString(), 'Ether') / web3.utils.fromWei(zrxOrder.takerAssetAmount.toString(), 'Ether'), 'Gas': myGasPrice2, 'Timestamp': now() }]);
        console.log('orderInfo', orderInfo);
    }
    if (profitable) {
        console.log('profitable:', profitable, ' netProfit: ', netProfit, 'in string;', netProfit.toString(), 'inputAssetAmount:', inputAssetAmount, 'outputAssetAmount:', outputAssetAmount);
        if (profitableArbFound) return;
        profitableArbFound = true;
        console.table([{ 'Profitable?': profitable, 'Asset Order': assetOrder.join(', '), 'Exchange Order': 'ZRX, 1Split', 'Input': displayTokens(inputAssetAmount, assetOrder[0]), 'Output': displayTokens(outputAssetAmount, assetOrder[0]), 'Profit': displayTokens(netProfit.toString(), assetOrder[0]), 'Timestamp': now() }]);
        fs.appendFile('arbbot_trades.txt', `${assetOrder.join(', ')}, ${displayTokens(netProfit.toString(), assetOrder[0])} , ${displayTokens(estimatedGasFee.toString(), assetOrder[0])} , ${displayTokens(inputAssetAmount, assetOrder[0])} , ${displayTokens(outputAssetAmount, assetOrder[0])}, ${now()}\n`, (err) => {
            if (err) throw err;
            console.log("File is updated.");
        });
        playSound();
        await trade(assetOrder[0], ASSET_ADDRESSES[assetOrder[0]], ASSET_ADDRESSES[assetOrder[1]], zrxOrder, inputAssetAmount, oneSplitData);
    }
};

const trade = async (flashTokenSymbol, flashTokenAddress, arbTokenAddress, orderJson, fillAmount, oneSplitData) => {
    const FLASH_AMOUNT = toTokens('100', flashTokenSymbol);
    const FROM_TOKEN = flashTokenAddress;
    const FROM_AMOUNT = fillAmount;
    const TO_TOKEN = arbTokenAddress;
    const orderTuple = [orderJson.makerAddress, orderJson.takerAddress, orderJson.feeRecipientAddress, orderJson.senderAddress, orderJson.makerAssetAmount, orderJson.takerAssetAmount, orderJson.makerFee, orderJson.takerFee, orderJson.expirationTimeSeconds, orderJson.salt, orderJson.makerAssetData, orderJson.takerAssetData, orderJson.makerFeeAssetData, orderJson.takerFeeAssetData];
    const takerAssetFillAmount = FROM_AMOUNT;
    const signature = orderJson.signature;
    const data = web3.eth.abi.encodeFunctionCall(FILL_ORDER_ABI, [orderTuple, takerAssetFillAmount, signature]);
    const minReturn = oneSplitData.returnAmount;
    const distribution = oneSplitData.distribution;
    const minReturnWithSlippage = (new web3.utils.BN(minReturn)).mul(new web3.utils.BN('995')).div(new web3.utils.BN('1000')).toString();
    if (myGasPrice2 === 0) myGasPrice2 = process.env.GAS_PRICE;
    const receipt = await traderContract.methods.getFlashloan(flashTokenAddress, FLASH_AMOUNT, arbTokenAddress, data, minReturnWithSlippage.toString(), distribution).send({
        from: process.env.ADDRESS,
        gas: process.env.GAS_LIMIT,
        gasPrice: web3.utils.toWei(myGasPrice2.toString(), 'Gwei')
    });
    console.log(receipt);
};

// FETCH ORDERBOOK
const checkOrderBook = async (baseAssetSymbol, quoteAssetSymbol) => {
    const baseAssetAddress = ASSET_ADDRESSES[baseAssetSymbol].substring(2, 42);
    const quoteAssetAddress = ASSET_ADDRESSES[quoteAssetSymbol].substring(2, 42);
    let zrxResponse;
    total0xCalls++;
    try {
        zrxResponse = await axios.get(`https://api.0x.org/sra/v3/orderbook?baseAssetData=0xf47261b0000000000000000000000000${baseAssetAddress}&quoteAssetData=0xf47261b0000000000000000000000000${quoteAssetAddress}&perPage=1000`);
    } catch (error) {
        total0xCallsFailed++;
        const elapsedTime = Math.floor(Date.now() / 1000) - startTimeBot;
        console.log('exception axios -', 'failure ratio:', total0xCallsFailed / total0xCalls, 'total0xCallsFailed', total0xCallsFailed, 'total0xCalls', total0xCalls, 'elapsed time', elapsedTime, 'success calls/sec', (total0xCalls - total0xCallsFailed) / elapsedTime);
        return;
    }
    const zrxData = zrxResponse.data;
    const bids = zrxData.bids.records;
    bids.map((o) => checkArb({ zrxOrder: o.order, assetOrder: [baseAssetSymbol, quoteAssetSymbol, baseAssetSymbol] }));
};

const showOrdersStats = () => {
    console.log('orders stats - total', totalOrders);
    ordersMapStats.forEach((value, key) => {
        console.log(key, value);
    });
};

// CHECK MARKETS
let checkingMarkets = false;
const checkMarkets = async () => {
    if (checkingMarkets) return;
    if (profitableArbFound) clearInterval(marketChecker);
    console.log('#', fetchingLoop++, ' Gas Price:', myGasPrice2, ` Fetching market data @ ${now()} ...\n`);
    showOrdersStats();
    checkingMarkets = true;
    try {
        await checkOrderBook(WETH, DAI);
        await checkOrderBook(WETH, LINK);
        await checkOrderBook(WETH, YFI);
    } catch (error) {
        console.error(error);
        return;
    }
    checkingMarkets = false;
};

// RUN APP
playSound();
const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 3000;
const marketChecker = setInterval(async () => { await checkMarkets(); }, POLLING_INTERVAL);