pragma solidity ^0.5.0;
pragma experimental ABIEncoderV2;

interface Structs {
    struct Val {
        uint256 value;
    }

    enum ActionType { Deposit, Withdraw, Transfer, Buy, Sell, Trade, Liquidate, Vaporize, Call }
    enum AssetDenomination { Wei }
    enum AssetReference { Delta }

    struct AssetAmount {
        bool sign; // true if positive
        AssetDenomination denomination;
        AssetReference ref;
        uint256 value;
    }

    struct ActionArgs {
        ActionType actionType;
        uint256 accountId;
        AssetAmount amount;
        uint256 primaryMarketId;
        uint256 secondaryMarketId;
        address otherAddress;
        uint256 otherAccountId;
        bytes data;
    }

    struct Info {
        address owner;
        uint256 number;
    }

    struct Wei {
        bool sign;
        uint256 value;
    }
}

interface DyDxPool is Structs {
    function getAccountWei(Info calldata account, uint256 marketId) external view returns (Wei memory);
    function operate(Info[] calldata, ActionArgs[] calldata) external;
}

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

interface IOneSplit {
    function getExpectedReturn(
        IERC20 fromToken,
        IERC20 toToken,
        uint256 amount,
        uint256 parts,
        uint256 disableFlags
    )
        external
        view
        returns (uint256 returnAmount, uint256[] memory distribution);

    function swap(
        IERC20 fromToken,
        IERC20 toToken,
        uint256 amount,
        uint256 minReturn,
        uint256[] memory distribution,
        uint256 disableFlags
    ) external payable;
}

contract DyDxFlashLoan is Structs {
    DyDxPool private pool = DyDxPool(0x1E0447b19BB6EcFdAe1e4AE1694b0C3659614e4e);

    address public WETH = 0xC02aaA39b223FE8D0A0e5C4f27eAD9083C756Cc2;
    address public SAI = 0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359;
    address public USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    mapping(address => uint256) public currencies;

    constructor() public {
        currencies[WETH] = 1;
        currencies[SAI] = 2;
        currencies[USDC] = 3;
        currencies[DAI] = 4;
    }

    modifier onlyPool() {
        require(msg.sender == address(pool), "FlashLoan: Only DyDx pool can call");
        _;
    }

    function tokenToMarketId(address token) public view returns (uint256) {
        uint256 marketId = currencies[token];
        require(marketId != 0, "FlashLoan: Unsupported token");
        return marketId - 1;
    }

    function flashloan(address token, uint256 amount, bytes memory data) internal {
        IERC20(token).approve(address(pool), amount + 1);
        Info[] memory infos = new Info[](1);
        ActionArgs[] memory args = new ActionArgs[](3);

        infos[0] = Info(address(this), 0);

        args[0] = ActionArgs(
            ActionType.Withdraw,
            0,
            AssetAmount(false, AssetDenomination.Wei, AssetReference.Delta, amount),
            tokenToMarketId(token),
            0,
            address(this),
            0,
            ""
        );

        args[1] = ActionArgs(
            ActionType.Call,
            0,
            AssetAmount(false, AssetDenomination.Wei, AssetReference.Delta, 0),
            0,
            0,
            address(this),
            0,
            data
        );

        args[2] = ActionArgs(
            ActionType.Deposit,
            0,
            AssetAmount(true, AssetDenomination.Wei, AssetReference.Delta, amount + 1),
            tokenToMarketId(token),
            0,
            address(this),
            0,
            ""
        );

        pool.operate(infos, args);
    }
}

contract TradingBot is DyDxFlashLoan {
    uint256 public loan;
    address payable public OWNER;
    address private constant ONE_SPLIT_ADDRESS = 0xC586BeF4a0992C495Cf22e1aeEE4E446CECDee0E;
    uint256 private constant PARTS = 10;
    uint256 private constant FLAGS = 0;
    address private constant ZRX_EXCHANGE_ADDRESS = 0x61935CbDd02287B511119DDb11Aeb42F1593b7Ef;
    address private constant ZRX_ERC20_PROXY_ADDRESS = 0x95E6F48254609A6ee006F7D493c8e5fB97094ceF;
    address private constant ZRX_STAKING_PROXY = 0xa26e80e7Dea86279c6d778D702Cc413E6CFfA777;

    modifier onlyOwner() {
        require(msg.sender == OWNER, "caller is not the owner!");
        _;
    }

    constructor() public payable {
        OWNER = msg.sender;
        _getWeth(msg.value);
        _approveWeth(msg.value);
    }

    function() external payable {}

    function getFlashloan(
        address flashToken,
        uint256 flashAmount,
        address arbToken,
        bytes calldata zrxData,
        uint256 oneSplitMinReturn,
        uint256[] calldata oneSplitDistribution
    ) external payable onlyOwner {
        uint256 balanceBefore = IERC20(flashToken).balanceOf(address(this));
        bytes memory data = abi.encode(flashToken, flashAmount, balanceBefore, arbToken, zrxData, oneSplitMinReturn, oneSplitDistribution);
        flashloan(flashToken, flashAmount, data);
    }

    function callFunction(
        address, /* sender */
        Info calldata, /* accountInfo */
        bytes calldata data
    ) external onlyPool {
        (address flashToken, uint256 flashAmount, uint256 balanceBefore, address arbToken, bytes memory zrxData, uint256 oneSplitMinReturn, uint256[] memory oneSplitDistribution) = abi.decode(data, (address, uint256, uint256, address, bytes, uint256, uint256[]));
        uint256 balanceAfter = IERC20(flashToken).balanceOf(address(this));
        require(balanceAfter - balanceBefore == flashAmount, "contract did not get the loan");
        loan = balanceAfter;

        _arb(flashToken, arbToken, flashAmount, zrxData, oneSplitMinReturn, oneSplitDistribution);
    }

    function arb(
        address _fromToken,
        address _toToken,
        uint256 _fromAmount,
        bytes memory _0xData,
        uint256 _1SplitMinReturn,
        uint256[] memory _1SplitDistribution
    ) public payable onlyOwner {
        _arb(_fromToken, _toToken, _fromAmount, _0xData, _1SplitMinReturn, _1SplitDistribution);
    }

    function _arb(
        address _fromToken,
        address _toToken,
        uint256 _fromAmount,
        bytes memory _0xData,
        uint256 _1SplitMinReturn,
        uint256[] memory _1SplitDistribution
    ) internal {
        uint256 _startBalance = IERC20(_fromToken).balanceOf(address(this));
        _trade(_fromToken, _toToken, _fromAmount, _0xData, _1SplitMinReturn, _1SplitDistribution);
        uint256 _endBalance = IERC20(_fromToken).balanceOf(address(this));
        require(_endBalance > _startBalance, "End balance must exceed start balance.");
    }

    function trade(
        address _fromToken,
        address _toToken,
        uint256 _fromAmount,
        bytes memory _0xData,
        uint256 _1SplitMinReturn,
        uint256[] memory _1SplitDistribution
    ) public payable onlyOwner {
        _trade(_fromToken, _toToken, _fromAmount, _0xData, _1SplitMinReturn, _1SplitDistribution);
    }

    function _trade(
        address _fromToken,
        address _toToken,
        uint256 _fromAmount,
        bytes memory _0xData,
        uint256 _1SplitMinReturn,
        uint256[] memory _1SplitDistribution
    ) internal {
        uint256 _beforeBalance = IERC20(_toToken).balanceOf(address(this));
        _zrxSwap(_fromToken, _fromAmount, _0xData);
        uint256 _afterBalance = IERC20(_toToken).balance
