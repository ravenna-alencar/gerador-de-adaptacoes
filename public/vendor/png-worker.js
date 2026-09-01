/* Compressão de PNG do Gerador de Adaptações — roda fora da thread da tela.
   O Catalog recusa arquivo acima de 960KB. A ordem aqui é da menos destrutiva para a mais:
     1. zera o RGB dos pixels 100% transparentes (invisível, mas ajuda muito o deflate);
     2. tenta PNG SEM PERDA nenhuma — quando cabe, é o resultado ideal e para aqui;
     3. reduz a paleta pelo MAIOR número de cores que ainda caiba (busca binária).
   Reduzir resolução é a última carta e quem faz é a tela (precisa de canvas): quando nem
   32 cores couberem, este worker responde precisaReduzir:true e a tela manda de novo menor. */
importScripts('/vendor/upng.js');

// Da paleta mais pobre pra mais rica — a busca binária procura o maior índice que caiba.
var CORES = [32, 48, 64, 96, 128, 192, 256];

// Pixel transparente com RGB "sujo" sobrando do canvas não aparece em lugar nenhum, mas
// enche o deflate de ruído. Zerar deixa a área toda idêntica e comprime muito melhor.
function limpaAlpha(u8) {
  for (var i = 0; i < u8.length; i += 4) {
    if (u8[i + 3] === 0) { u8[i] = 0; u8[i + 1] = 0; u8[i + 2] = 0; }
  }
}

// Conta cores distintas parando no teto — só serve pra decidir se vale tentar sem perda.
function coresUnicas(u8, teto) {
  var v32 = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2);
  var vistas = new Set();
  for (var i = 0; i < v32.length; i++) {
    vistas.add(v32[i]);
    if (vistas.size > teto) return teto + 1;
  }
  return vistas.size;
}

// UPNG.encode não altera o buffer de entrada (testado), então a busca binária reusa o mesmo.
function encoda(buf, w, h, cnum) { return UPNG.encode([buf], w, h, cnum); }

self.onmessage = function (ev) {
  var d = ev.data, t0 = Date.now();
  try {
    var u8 = new Uint8Array(d.rgba);
    limpaAlpha(u8);
    var px = d.w * d.h;
    // Imagem gigante E cheia de cor: o deflate sem perda custa muitos segundos e não vai
    // caber de jeito nenhum. Nesses casos pula direto pra paleta.
    var valeLossless = d.tentarLossless !== false && (px <= 12e6 || coresUnicas(u8, 4096) <= 4096);
    if (valeLossless) {
      var puro = encoda(u8.buffer, d.w, d.h, 0);
      if (puro.byteLength <= d.limite) {
        self.postMessage({ id: d.id, ok: true, png: puro, semPerda: true, cores: null,
          bytes: puro.byteLength, ms: Date.now() - t0 }, [puro]);
        return;
      }
    }
    var lo = 0, hi = CORES.length - 1, melhor = null;
    while (lo <= hi) {
      var meio = (lo + hi) >> 1;
      var png = encoda(u8.buffer, d.w, d.h, CORES[meio]);
      if (png.byteLength <= d.limite) { melhor = { png: png, cores: CORES[meio] }; lo = meio + 1; }
      else hi = meio - 1;
    }
    if (melhor) {
      self.postMessage({ id: d.id, ok: true, png: melhor.png, semPerda: false, cores: melhor.cores,
        bytes: melhor.png.byteLength, ms: Date.now() - t0 }, [melhor.png]);
      return;
    }
    var minimo = encoda(u8.buffer, d.w, d.h, CORES[0]);
    self.postMessage({ id: d.id, ok: false, precisaReduzir: true,
      menorBytes: minimo.byteLength, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, erro: String((err && err.message) || err) });
  }
};
