const BLOCKCHAIN_EXPLORERS = Object.freeze({
  bsc: {
    transactionBaseUrl: "https://bscscan.com/tx/",
    transactionHashPattern: /^0x[0-9a-fA-F]{64}$/,
  },
  tron: {
    transactionBaseUrl: "https://tronscan.org/#/transaction/",
    transactionHashPattern: /^[0-9a-fA-F]{64}$/,
  },
  arbitrum: {
    transactionBaseUrl: "https://arbiscan.io/tx/",
    transactionHashPattern: /^0x[0-9a-fA-F]{64}$/,
  },
});

export function blockchainTransactionUrl(params = {}) {
  const network = String(params.network || "").trim().toLowerCase();
  const transactionHash = String(params.transactionHash || params.transaction_hash || "").trim();
  const explorer = BLOCKCHAIN_EXPLORERS[network];
  if (!explorer) {
    throw new Error("该支付方式没有可用的区块链浏览器记录");
  }
  if (!explorer.transactionHashPattern.test(transactionHash)) {
    throw new Error("交易哈希格式无效");
  }
  return `${explorer.transactionBaseUrl}${transactionHash}`;
}
