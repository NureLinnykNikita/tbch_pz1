# ПЗ 1 — блокчейн на TypeScript

Навчальний блокчейн: гаманці Ed25519, транзакції, мемпул, дерево Меркла, майнінг PoW і три HTTP-вузли. Алгоритми блокчейну написані вручну; для криптографії використано `node:crypto`.

## Запуск

Потрібен Node.js 24 або новіший. У корені проєкту:

```sh
npm ci
npm run network
```

Запустяться три окремі процеси на портах 3001, 3002, 3003. Вони автоматично з'єднаються. Ctrl+C зупиняє мережу; файли `data/node-PORT.json` зберігають стан для наступного запуску.

## Перевірка

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run demo
npm run benchmark
```

- `test` — 20 автоматичних тестів.
- `demo` — п'ять атак, синхронізація трьох процесів, розгалуження, повернення переказу в мемпул і перезапуск. Використовує окремі порти 4311–4313 та тимчасові файли; після завершення зупиняє вузли.
- `benchmark` — по 20 вимірювань для складності 1–4; записує JSON і CSV в `evidence/`. Вимірюється лише пошук nonce, без мережі та диска. Графік у звіті відповідає зафіксованому запуску.

## Гаманець і переказ

```sh
node scripts/client.ts wallet wallets/alice.json
node scripts/client.ts wallet wallets/bob.json
```

Підставте в наступні команди адреси з виводу:

```sh
curl -X POST http://127.0.0.1:3001/mine -H 'Content-Type: application/json' -d '{"address":"АДРЕСА_ALICE"}'
node scripts/client.ts send wallets/alice.json АДРЕСА_BOB 10 1
curl -X POST http://127.0.0.1:3002/mine -H 'Content-Type: application/json' -d '{"address":"АДРЕСА_BOB"}'
curl 'http://127.0.0.1:3001/balance?address=АДРЕСА_ALICE'
curl http://127.0.0.1:3001/validate
```

Приватний ключ залишається в локальному файлі гаманця. `wallets/` і `data/` виключені з Git.

## API

| Метод і маршрут               | Призначення                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| POST /wallet                  | Створити гаманець                                              |
| POST /transactions            | Подати підписаний переказ                                      |
| POST /mine                    | Намайнити блок; тіло `{"address":"..."}`                       |
| GET /chain                    | Показати ланцюг                                                |
| GET /balance?address=…        | Показати баланс і nonce                                        |
| GET /validate                 | Перевірити весь ланцюг                                         |
| POST /peers                   | Додати сусіда; `{"url":"http://127.0.0.1:3002"}`               |
| POST /sync                    | Синхронізуватися                                               |
| GET /health, /mempool, /peers | Стан вузла, черга, сусіди                                      |
| POST /network                 | Вимкнути/увімкнути gossip та sync: `{"online":false}` / `true` |

`/gossip/transaction` і `/gossip/block` використовуються вузлами для поширення даних. REST працює лише на 127.0.0.1, без автентифікації; майнінг синхронний. Це локальна навчальна модель без захисту від атаки більшості потужності, DoS або викрадення ключа.

## Файли

- `src/crypto.ts` — ключі, підписи, канонічний JSON;
- `src/merkle.ts` — корінь Меркла;
- `src/blockchain.ts` — ланцюг, мемпул, PoW, перевірка, збереження;
- `src/server.ts` — HTTP і синхронізація;
- `scripts/` — запуск, клієнт, демонстрація та експеримент;
- `tests/`, `evidence/`, `report/` — тести, результати та звіт.
