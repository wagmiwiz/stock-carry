export {};
declare module "circuit:sdk" {
  interface AgentSettings {
    readonly "stock": "GOOGL" | "NVDA" | "META" | "TSLA" | "AAPL" | "AMZN" | "MSFT";
    readonly "position": "hold" | "exit_weekends" | "close";
    readonly "rebalance_gap": number;
  }
}
