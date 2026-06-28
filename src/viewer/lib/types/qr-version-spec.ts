// One QR version's capacity row (ISO/IEC 18004, error-correction level L). The codec
// picks the smallest version whose maxPayloadBytes fits the data.
interface QrVersionSpec {
  version: number;        // 1..10
  totalCodewords: number; // data + EC codewords
  ecPerBlock: number;     // EC codewords per RS block
  blocks: number;         // number of RS blocks (data is split + interleaved from v6 on)
  maxPayloadBytes: number;
}
