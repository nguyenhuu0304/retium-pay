# Safehouse reference publisher — testnet

Dịch vụ riêng cho market `82f342939b74a4b3d7d25f91efc7c6513657ec65a2ad26fea7c80eefeddb16b1`, oracle ví `rete5562395fa3d8f4713742d55de025e43ed6e34628ef3657e39033b069808527229e82`.

Nguồn là tham chiếu Safehouse cố định 1 RTM = 1 RTD, không phải giá thị trường phi tập trung hoặc xác nhận dự trữ fiat. Kiểm tra danh tính, token, số liệu tồn kho và code hash trước khi cập nhật. Giá quá 15 phút vẫn chặn Borrow; trả nợ và rút trong giới hạn contract không yêu cầu giá mới.

## Kiểm tra trước khi chạy

Dockerfile ghim SDK commit `09f27815236946d67a9be5984504a5bcdf8cb7cd`, xây binary retium từ mã nguồn. Chưa chạy Docker build trong môi trường kiểm thử hiện tại. Cần để máy chủ build và kiểm tra probe thành công trước khi bật chế độ run.

Tạo một service riêng từ repo, thư mục gốc `services/safehouse-oracle`, Dockerfile cùng thư mục. Không đổi service Telegram/Payments hiện tại. Chỉ một replica. Gắn volume vào `/data`; state pending phải tồn tại qua restart. Trong lần triển khai đầu, để `RETIUM_ORACLE_MODE=probe`: chỉ đọc, không cần khóa, tiến trình kết thúc sau probe. Chỉ sau khi kiểm tra build/probe mới đổi sang `run`.

Các biến không bí mật có trong `variables.example`. Ở chế độ run thêm biến bí mật của dịch vụ:

- `RETIUM_API_KEY`: developer API key hợp lệ.
- `RETIUM_ORACLE_KEY_BASE64`: nội dung base64 file `.sk` **chỉ của ví oracle e82**, không dùng khóa ví chủ cb37.

Base64 không phải mã hóa bảo mật. Không đưa vào Git, chat hoặc screenshot. Trên máy có file oracle, có thể sao chép vào clipboard bằng PowerShell (không in khóa ra màn hình):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\RetiumKeys\safehouse-oracle-test.sk")) | Set-Clipboard
```

Dán trực tiếp vào biến bí mật, rồi xóa clipboard bằng `Set-Clipboard -Value ""`. Chương trình kiểm tra địa chỉ thực của khóa trước khi gọi contract. Không chứa hay cần khóa owner.

## Chi phí và dừng an toàn

Khi giá cần cập nhật, worker gửi một `refresh_price`, sau đó xác minh TX độc lập và đọc lại giá. Khoảng mục tiêu 5 phút, tối đa 288 lần gửi/ngày. Với phí hiện quan sát 0.5 RTM/lần, có thể cần khoảng **144 RTM test/ngày**. Phí có thể đổi. 3 RTM không đủ duy trì nhiều ngày. Worker kiểm tra số dư dự phòng và dừng gửi nếu không đủ, không tự nạp tiền.

State lưu ý định trước khi ký. Nếu CLI bị ngắt mà chưa lấy được TX ID, worker giữ pending và không tự gửi lại. Khi có lỗi unknown/halted, cần đối chiếu lịch sử ví trước khi phục hồi; không xóa state để ép chạy. `/tmp` giữ khóa chạy cục bộ; `/data/oracle-state.json` giữ state bền vững. Không chạy hai worker trên hai máy cùng lúc, kể cả worker local cũ.

Bản này không cập nhật hoặc xóa file `oracle-state.json` của gói standalone cũ. Đừng sao chép state cũ sang service mới nếu chưa đối chiếu định dạng và TX pending. Nếu service mới thấy giá on-chain còn mới, nó chờ đến kỳ tiếp theo.

Không có gì tự triển khai, tự cấp quyền hay tự gửi tiền khi cài bản cập nhật app. Việc triển khai service là bước riêng sau khi app đã kiểm tra xong.
