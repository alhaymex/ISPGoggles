# ISPGoggles

A tool that test your internet speed with and compare it with OOKLA speedtest

## Why

I noticed a significant discrepancy between my 500Mbps plan and my actual browsing/download speeds. After investigation, I discovered my ISP prioritizes traffic specifically to Speedtest servers to maintain the illusion of high performance. This project aims to bypass that "speedtest bias" by measuring raw throughput against non-standard endpoints.

## Usage

This tool compares raw HTTPS throughput against prioritized Speedtest.net traffic to detect ISP traffic shaping.

Prerequisites
  - Bun: The project is built for the Bun runtime.
  - Speedtest CLI: To compare against "official" results, you must have the Ookla Speedtest CLI - - - installed and available in your $PATH.

1. Local Setup

   Clone the repository and install dependencies:
   ```
   git clone https://github.com/alhaymex/ISPGoggles.git
   ```
   ```
   bun install 
   ```

   To start the bias check:
   ```
   bun start
   ```

2. Running with Docker

   If you prefer to run the tool without managing dependencies locally, use the provided Docker configuration.

   Build the image:
   ```
   docker build -t ispgoggles .
   ```

   Run the container:
   ```
   docker run -it --rm ispgoggles
   ```

## configuration
You can customize the test parameters directly in index.ts within the CONFIG object:


| Setting                | Description                                               | Default      |
|------------------------|----------------------------------------------------------|--------------|
| rounds                 | How many times to repeat the full test cycle.            | 5            |
| restSecondsBetween     | Delay between rounds to allow the network to "cool down."| 3s           |
| secondsPerRound        | Duration of the raw HTTPS download test.                 | 12s          |
| parallel               | Number of concurrent workers (simultaneous connections). | 6            |
| chunkBytes             | Size of the range-request chunks (8 MiB recommended).    | "8,388,608"  |


## Understanding the Output
  1. The Ratio (Ookla/Non): A ratio significantly higher than 1.5x suggests your ISP is detecting speedtest traffic and moving it to a faster, prioritized "lane."

  1. Stability (σ): If the Standard Deviation for raw traffic is high while the Speedtest traffic is perfectly flat, it indicates your real-world traffic is being actively managed or throttled while benchmarks are protected.