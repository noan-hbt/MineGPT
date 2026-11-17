| model                          |       size |     params | backend    | ngl | threads |  fa |            test |                  t/s |
| ------------------------------ | ---------: | ---------: | ---------- | --: | ------: | --: | --------------: | -------------------: |
| lfm3 1.7B Q4_0                 | 993.13 MiB |     1.73 B | CUDA       |  99 |       8 |   1 |           pp512 |    12707.19 ± 795.19 |
| lfm3 1.7B Q4_0                 | 993.13 MiB |     1.73 B | CUDA       |  99 |       8 |   1 |           tg128 |        182.67 ± 3.98 |
| lfm3 1.7B Q4_0                 | 993.13 MiB |     1.73 B | CUDA       |  99 |       8 |   0 |           pp512 |    12015.58 ± 255.80 |
| lfm3 1.7B Q4_0                 | 993.13 MiB |     1.73 B | CUDA       |  99 |       8 |   0 |           tg128 |        181.95 ± 0.54 |
| k2-horizon 4B Q4_K - Medium    |   2.93 GiB |     5.06 B | CUDA       |  99 |       8 |   1 |           pp512 |     5249.80 ± 176.34 |
| k2-horizon 4B Q4_K - Medium    |   2.93 GiB |     5.06 B | CUDA       |  99 |       8 |   1 |           tg128 |         75.57 ± 1.23 |
| k2-horizon 4B Q4_K - Medium    |   2.93 GiB |     5.06 B | CUDA       |  99 |       8 |   0 |           pp512 |      4335.09 ± 62.05 |
| k2-horizon 4B Q4_K - Medium    |   2.93 GiB |     5.06 B | CUDA       |  99 |       8 |   0 |           tg128 |         73.34 ± 0.13 |
| lfm3 1.7B Q4_K - Medium        |   1.05 GiB |     1.73 B | CUDA       |  99 |       8 |   1 |           pp512 |    13231.49 ± 402.73 |
| lfm3 1.7B Q4_K - Medium        |   1.05 GiB |     1.73 B | CUDA       |  99 |       8 |   1 |           tg128 |        175.03 ± 0.16 |
| lfm3 1.7B Q4_K - Medium        |   1.05 GiB |     1.73 B | CUDA       |  99 |       8 |   0 |           pp512 |    11894.60 ± 170.07 |
| lfm3 1.7B Q4_K - Medium        |   1.05 GiB |     1.73 B | CUDA       |  99 |       8 |   0 |           tg128 |        172.72 ± 0.34 |
| nemotron_h ?B Q4_K - Medium    |   2.63 GiB |     3.97 B | CUDA       |  99 |       8 |   1 |           pp512 |     4500.51 ± 121.13 |
| nemotron_h ?B Q4_K - Medium    |   2.63 GiB |     3.97 B | CUDA       |  99 |       8 |   1 |           tg128 |         82.20 ± 0.09 |
| nemotron_h ?B Q4_K - Medium    |   2.63 GiB |     3.97 B | CUDA       |  99 |       8 |   0 |           pp512 |      4423.26 ± 37.15 |
| nemotron_h ?B Q4_K - Medium    |   2.63 GiB |     3.97 B | CUDA       |  99 |       8 |   0 |           tg128 |         81.84 ± 0.30 |
| spark2_5 ?B Q4_K - Medium      |   2.49 GiB |     4.11 B | CUDA       |  99 |       8 |   1 |           pp512 |     5491.05 ± 225.61 |
| spark2_5 ?B Q4_K - Medium      |   2.49 GiB |     4.11 B | CUDA       |  99 |       8 |   1 |           tg128 |         80.29 ± 0.14 |
| spark2_5 ?B Q4_K - Medium      |   2.49 GiB |     4.11 B | CUDA       |  99 |       8 |   0 |           pp512 |      4934.33 ± 84.46 |
| spark2_5 ?B Q4_K - Medium      |   2.49 GiB |     4.11 B | CUDA       |  99 |       8 |   0 |           tg128 |         76.94 ± 0.05 |
| spark2_5 ?B Q4_K - Medium      |   3.30 GiB |     4.45 B | CUDA       |  99 |       8 |   1 |           pp512 |      5481.47 ± 26.67 |
| spark2_5 ?B Q4_K - Medium      |   3.30 GiB |     4.45 B | CUDA       |  99 |       8 |   1 |           tg128 |         75.45 ± 0.07 |
| spark2_5 ?B Q4_K - Medium      |   3.30 GiB |     4.45 B | CUDA       |  99 |       8 |   0 |           pp512 |      4856.26 ± 67.24 |
| spark2_5 ?B Q4_K - Medium      |   3.30 GiB |     4.45 B | CUDA       |  99 |       8 |   0 |           tg128 |         72.45 ± 0.23 |
| qwen35 2B Q2_0                 | 510.87 MiB |     1.88 B | CUDA       |  99 |       8 |   1 |           pp512 |    12048.80 ± 251.08 |
| qwen35 2B Q2_0                 | 510.87 MiB |     1.88 B | CUDA       |  99 |       8 |   1 |           tg128 |        254.13 ± 0.19 |
| qwen35 2B Q2_0                 | 510.87 MiB |     1.88 B | CUDA       |  99 |       8 |   0 |           pp512 |    11738.14 ± 210.16 |
| qwen35 2B Q2_0                 | 510.87 MiB |     1.88 B | CUDA       |  99 |       8 |   0 |           tg128 |        248.11 ± 0.60 |

build: ef3848f9d (12445)
