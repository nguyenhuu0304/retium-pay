# Retium Pay Lending — isolated testnet prototype

Built against Retium Pay commit `5e491ce1ce94475e6cd458e6e92ad6a8b1b7b9c0` and official SDK commit `09f27815236946d67a9be5984504a5bcdf8cb7cd`.

## Trạng thái thật của bản này

- Có contract WASM, mã nguồn, kiểm thử mô phỏng và tích hợp `/lending`.
- Gửi/rút tài sản cho vay; gửi/rút RTM thế chấp; vay/trả nợ; Health Factor; thanh lý qua contract.
- Chưa deploy contract lên mạng Retium; chưa thử chuyển RTD qua contract thật; chưa kiểm toán.
- Chưa xác minh contract RTD chính thức. Không tự suy ra contract từ tên/symbol.
- Chưa có oracle phi tập trung. Quản trị nhập giá thử nghiệm, hết hạn sau 15 phút.
- Lending khóa mặc định; không có số dư hoặc lợi nhuận giả. Payments/DEX không dùng chung quỹ lending.
- Không mở cho tài sản có giá trị thật. Bản đầu phù hợp kiểm thử có kiểm soát trước khi mở rộng người dùng testnet.

## Cài giao diện trước

Tải ZIP về Downloads, mở PowerShell và chạy từng dòng:

```powershell
cd "D:\Projects\Retium\RetiumPay_GitHub_20261016\retium-pay"
Expand-Archive -LiteralPath "$HOME\Downloads\RetiumPay_Lending_Testnet.zip" -DestinationPath "D:\Projects\Retium\RetiumPay_Lending_Testnet" -Force
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Projects\Retium\RetiumPay_Lending_Testnet\install-lending.ps1"
.\node_modules\.bin\tsc.cmd --project tsconfig.json --noEmit --incremental false
npm run lint
npm run build
node .\scripts\lending\test-plans.mjs
```

Installer kiểm tra phiên bản từng file trước khi ghi, sao lưu cả hai thư mục dự án nếu có, không sửa `.env.local`, database, seed hay dữ liệu. Nếu file khác bản gốc, installer dừng toàn bộ trước khi ghi để tránh mất cập nhật mới của bạn. Bộ cài không tự push, deploy hay ký giao dịch.

Mở local:

```powershell
npm run dev
```

Vào `http://localhost:3000/lending`. Khi chưa cấu hình sẽ hiện **Market awaiting verification**. Đây là trạng thái chờ xác minh có chủ đích, không phải lỗi load.

## Bước kế tiếp: xác định tài sản cho vay

Trước hết chỉ đọc ví và xác định đúng RTD. Không gửi private key, seed, API key hoặc DATABASE_URL.

```powershell
cd "D:\Projects\Retium\retium-sdk"
retium balance retef25ddec9d77f15810718a59551061df10024179bc6da4952432f236448575a88cb37
```

Đối chiếu token ID với Retium Money / tài liệu chính thức. Sau khi có ID:

```powershell
$asset = Read-Host "Contract ID cua tai san test da doi chieu"
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Projects\Retium\RetiumPay_Lending_Testnet\inspect-asset.ps1" -ContractId $asset
```

Chỉ hỗ trợ token 18 decimals, có transfer / approve / transfer_from / balance_of / allowance và chuyển được với contract ID 64 ký tự. Symbol RTD chưa đủ chứng minh nguồn gốc. Nếu RTD không đáp ứng, phải dùng token test riêng và ghi đúng tên; không gắn nhãn RTD cho token khác.

## Contract / mô hình rủi ro

- Collateral: RTM native. Debt asset: một token 18 decimals, ID + code hash cố định lúc init.
- Giới hạn vay: 50% giá trị tài sản thế chấp. Ngưỡng thanh lý: 70%. Thưởng thanh lý: 5%; tối đa 50% debt shares mỗi lần.
- Borrow rate: 5%/năm theo thời gian block, index tích lũy ở mỗi thao tác. Lãi thực tế có ảnh hưởng của tần suất cộng dồn và làm tròn; không hứa APY cố định.
- Supply dùng cổ phần của tổng tài sản cash + accrued debt. Withdraw nhận token theo tỷ lệ cổ phần và cần đủ cash thực dụng.
- Repay nhận **debt shares**: số token kéo vào được tính tại lúc thực thi, không phải số nợ cũ trên màn hình. Giao diện chọn phần trăm vị thế và quy đổi sang shares sau mỗi lần đọc mới; không yêu cầu người dùng tự tính shares. Giao diện xin approve tối đa dự tính + 0.1% buffer, hiển thị nguyên số approve; đây không phải approve vô hạn.
- Không dùng float cho tiền; u128 với phép nhân trung gian u256, làm tròn có hướng và kiểm tra overflow.
- Quỹ RTM thế chấp được hạch toán riêng; không có hàm admin rút quỹ.
- Token code hash được kiểm tra khi chuyển tiền; nhận/gửi yêu cầu chênh lệch balance đúng số lượng, bao gồm balance người nhận. Token có phí chuyển hoặc hành vi khác chuẩn sẽ bị từ chối.
- Từ chối thao tác bằng trap để chain rollback cả caller, không nuốt lỗi cross-contract sau khi ghi state.
- Pause chặn supply/borrow mới. Repay, rút tài sản không còn bảo đảm nợ, và withdraw có cash vẫn được phép. Giá hết hạn chặn borrow/liquidate và rút collateral đang bảo đảm nợ.
- Direct donations không tự tăng cổ phần hoặc cash hạch toán. Không gửi token trực tiếp vào contract ngoài luồng supply.
- Owner nhập giá có thể làm sai định giá. Chưa có cơ chế tự xử lý bad debt khi giá sụt quá mạnh, chưa có keeper/oracle tự động hay bảo hiểm. Đây là giới hạn quan trọng, không phải bản lending đã sẵn sàng mainnet.
- Liquidation có trong contract; giao diện người vay không tự động ký thanh lý hay cập nhật giá.

## Build lại contract (không cần Rust)

Contract dùng AssemblyScript theo ABI của SDK Retium. Phần source để cạnh installer, không copy vào src app vì dùng kiểu WASM riêng.

```powershell
cd "D:\Projects\Retium\RetiumPay_Lending_Testnet\contract"
npm ci
npm run build
npm test
```

WASM: `contract\build\retium_lending.wasm`. Khi sửa source/build, phải thay file app `public\contracts\retium_lending.wasm` và cập nhật code hash cấu hình theo WASM mới.

Bản phát hành hiện tại BLAKE3: `417ba834c8cd6a0e15750eda486ac2743ff36ee4dbf8d6238f9881c0f46c0132`.

## Chuẩn bị deploy: chỉ dry-run trước

Dùng key testnet và API key đã cài ở phiên PowerShell riêng. Bộ cài không lấy hoặc lưu các key này.

```powershell
cd "D:\Projects\Retium\retium-sdk"
retium health
retium balance
retium deploy "D:\Projects\Retium\RetiumPay_Lending_Testnet\contract\build\retium_lending.wasm" --dry-run
```

Kiểm tra ABI/metadata/weight và phí từ node. Mô phỏng không chứng minh fuel, ABI hoặc quyền RTD trên node thực; phải qua dry-run và thử on-chain. Dừng nếu node không nhận đúng metadata testnet hoặc báo sai ABI.

## Khi đã kiểm tra và chủ động chọn deploy

Các lệnh dưới đây là giao dịch testnet thật, cần phí; không chạy cả khối một lượt. Chờ từng TX HardFinal + execution ok rồi mới tiếp tục. Thay biến bằng ID từ kết quả thật, không dùng chuỗi minh họa.

```powershell
retium deploy "D:\Projects\Retium\RetiumPay_Lending_Testnet\contract\build\retium_lending.wasm"
$market = Read-Host "Contract ID vua deploy"
retium contract $market
retium verify $market "D:\Projects\Retium\RetiumPay_Lending_Testnet\contract\build\retium_lending.wasm"
$asset = Read-Host "Debt asset ID da xac minh"
$assetHash = Read-Host "Debt asset code hash da xac minh"
retium call $market init $asset $assetHash
```

`init` lấy caller đầu tiên làm owner và luôn khởi tạo paused. Sau init, **bắt buộc đọc owner và đối chiếu với ví của bạn trước khi approve hay nạp tài sản**:

```powershell
retium query $market owner
retium query $market market
```

Nếu owner khác ví của bạn, dừng; không nạp tiền. Bộ này chưa bảo vệ khoảng thời gian từ deploy đến init bằng giao dịch atomic.

### Thử chuyển token một vòng trước khi bật thị trường

Probe chỉ được phép khi thị trường rỗng. Ví owner phải có ít nhất 0.001 token test và phí RTM. Approve là một TX riêng; chờ HardFinal rồi mới probe.

```powershell
retium call $asset approve $market 1000000000000000
retium call $market asset_probe 1000000000000000
retium query $market market
```

Probe kéo 0.001 token vào rồi gửi trả owner ngay trong cùng lời gọi, kiểm tra chênh lệch balance. Đòi hỏi `asset_verified` bằng `1`. Nếu thất bại, không bật market; phải kiểm tra contract token thật và runtime trước.

### Giá thử nghiệm và activate

`price` là số **debt tokens trên 1 RTM**, scale 1e18. Ví dụ 1e18 chỉ có nghĩa giá giả định test 1 token/RTM; **không phải giá RTM thật**. Owner phải tự chọn và công bố giá thử nghiệm. Không lấy giá từ pool mỏng NHT làm oracle.

```powershell
$priceAtomic = Read-Host "Gia thu nghiem debt-token/RTM, scale 1e18"
retium call $market set_price $priceAtomic
retium call $market activate
retium query $market market
```

Giá hết hạn sau 15 phút. Không tạo bot giá giả để duy trì khả năng vay. Chỉ cập nhật thủ công trong phiên test có kiểm soát.

### Kiểm thử on-chain bằng hai ví riêng

Dùng lượng nhỏ token test; không dùng một ví vừa giả làm chủ quỹ vừa giả làm người vay cho mọi phép kiểm tra.

1. Ví A approve một lượng test nhỏ, supply; query position và số dư trước/sau.
2. Ví B deposit_collateral bằng `retium call $market deposit_collateral --value 0.1` (0.1 RTM test), sau đó chỉ vay dưới giới hạn của chính ví B.
3. Chờ TX vay HardFinal/exec ok, đối chiếu balance token tăng và debt tăng, cash thị trường giảm.
4. Ví B approve token để trả nợ, repay bằng debt shares từ query position; rút collateral khi không còn nợ.
5. Ví A withdraw supply shares, đối chiếu token nhận về và cash.
6. Thử lỗi vay quá hạn mức, giá hết hạn, allowance thiếu, cash thiếu; phải không thay đổi balance/state sau lỗi.
7. Sau đó mới thử thanh lý qua `liquidate <borrower-wallet> <debt-shares>` trong thị trường test riêng với giá giả định công bố rõ.

Không có lệnh tự động vay hoặc tự động thanh lý trong bộ cài. Chưa chạy các bước live này trong môi trường xây dựng.

## Cấu hình app sau khi live test đạt

Thêm vào môi trường Vercel và Railway bằng ID/code hash thực. Các giá trị dưới là mẫu cần điền:

```dotenv
RETIUM_LENDING_ENABLED=false
RETIUM_LENDING_MARKET=<64-hex market ID>
RETIUM_LENDING_CODE_HASH=417ba834c8cd6a0e15750eda486ac2743ff36ee4dbf8d6238f9881c0f46c0132
RETIUM_LENDING_ASSET=<64-hex verified test asset ID>
RETIUM_LENDING_ASSET_CODE_HASH=<64-hex asset code hash>
RETIUM_LENDING_SYMBOL=<verified symbol>
```

Chỉ chuyển `ENABLED=true` sau khi owner, code hashes, probe và vòng supply/borrow/repay/withdraw đều đạt. Redeploy web và Railway cùng commit. Giữ nguyên APP_URL, DATABASE_URL và key Telegram đang dùng. Không cần database import lại.

Thông báo Telegram dùng hàng đợi verified TX hiện có, lưu Neon và xác minh từ Railway. Cần phiên xem đã ký / liên kết Telegram hiện có để đăng ký theo dõi. Nếu bị yêu cầu, vào My History ký phiên xem một lần rồi **Retry tracking**, không gửi giao dịch lần nữa. Approve chỉ báo Token approval; không báo hoàn tất vay.

Browser đọc để hiển thị; HMAC ticket không chứng minh số dư, finality hay lợi nhuận. Worker kiểm tra TX ID/sender/nonce/contract/method/attached RTM/finality/execution và code hashes. Nếu RPC không cung cấp call.args, worker không thể chứng minh đối số/amount token chính xác từ endpoint đó; vì vậy thông báo không khẳng định số token thực nhận. Vị thế cập nhật bằng query contract.

## Khôi phục giao dịch

- Chưa gửi, lỗi preview: nút thao tác mở lại bằng `finally`.
- Ví từ chối rõ ràng: bỏ trạng thái giữ, cho review lại.
- Đã có TX ID: lưu localStorage, Retry tracking hoặc Check transaction; Telegram chậm không giữ spinner và có đường quay lại DEX.
- Ví timeout/không có TX ID: không tự gửi lại. Dán TX từ wallet history để đối chiếu và tiếp tục kiểm tra. Không xóa trạng thái không chắc chắn chỉ để gửi thêm.
- Không tự ký, tự gửi tiền hoặc tự chạy lại thao tác sau refresh.

## Xác minh đã chạy

- AssemblyScript WASM compiled: 25–30 KB (xem file thực).
- 48 lượt gọi/thử từ chối WASM: supply, borrow, repayment, liquidation, paused/stale-price, rollback lỗi token/native, lãi sau 1 năm, overflow, query không cần caller ví.
- 500 phép tính mul/div u128 ngẫu nhiên so với BigInt, gồm overflow và làm tròn.
- Plan restrictions, approve tách biệt, mặc định disabled, kiểm tra nhận dạng TX/execution backend.
- TypeScript, ESLint, Next production build.
- HTTP smoke production: route Lending, API disabled, origin guard, từ chối write khi chưa bật, WASM tải được và hợp lệ.
- Installer PowerShell đã rà soát source nhưng chưa chạy trên Windows trong môi trường này.
- Chưa chạy browser visual QA (môi trường không tải được Chromium); chưa chạy giao dịch trên Retium node thật; chưa xác minh Telegram live cho Lending.

## Nguồn ABI và giới hạn

- https://github.com/Retium-Org/retium-sdk
- https://github.com/Retium-Org/retium-sdk/blob/09f27815236946d67a9be5984504a5bcdf8cb7cd/examples/hello_counter_as/assembly/index.ts
- https://github.com/Retium-Org/retium-sdk/blob/09f27815236946d67a9be5984504a5bcdf8cb7cd/docs/04-writing-contracts.md
- https://github.com/Retium-Org/retium-sdk/blob/09f27815236946d67a9be5984504a5bcdf8cb7cd/docs/07-security.md
