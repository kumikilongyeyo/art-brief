"""Weight-only int8 for ONNX models (compute stays fp32, so any runtime that has DequantizeLinear runs it).

Stock int8 exports use ConvInteger, which onnxruntime's CPU/wasm kernels reject, and full int8
activation quantization wrecks MobileCLIP. Storing weights as int8 + per-channel scale and
dequantizing at load keeps accuracy (cos >= 0.998 for MobileCLIP-S0) at ~1/3 the size.

usage: python quantize_weights.py in.onnx out.onnx [--fp32 name,...] [--fp16 name,...]
"""
import sys, onnx, numpy as np
from onnx import numpy_helper, helper, TensorProto, version_converter

def quantize(src, dst, keep32=(), keep16=(), min_size=4096):
    m = onnx.load(src)
    if max(o.version for o in m.opset_import if o.domain in ('', 'ai.onnx')) < 13:
        m = version_converter.convert_version(m, 17)  # per-axis DequantizeLinear needs opset >= 13
    g = m.graph
    users = {}
    for n in g.node:
        for k, x in enumerate(n.input):
            users.setdefault(x, []).append((n, k))
    add, nodes, drop = [], [], []
    for init in g.initializer:
        a = numpy_helper.to_array(init)
        us = users.get(init.name, [])
        if a.dtype != np.float32 or a.size < min_size or init.name in keep32: continue
        if not us or not all(n.op_type in ('Conv', 'Gemm', 'MatMul') and k == 1 for n, k in us): continue
        if init.name in keep16:
            add.append(numpy_helper.from_array(a.astype(np.float16), init.name + '_h'))
            nodes.append(helper.make_node('Cast', [init.name + '_h'], [init.name], to=TensorProto.FLOAT))
        else:
            op = us[0][0].op_type
            axis = 0 if op == 'Conv' else a.ndim - 1
            if op == 'Gemm':
                tb = [x.i for x in us[0][0].attribute if x.name == 'transB']
                axis = 0 if tb and tb[0] == 1 else 1
            red = tuple(i for i in range(a.ndim) if i != axis)
            s = np.abs(a).max(axis=red) / 127.0
            s[s == 0] = 1e-8
            shp = [1] * a.ndim; shp[axis] = -1
            q = np.clip(np.round(a / s.reshape(shp)), -127, 127).astype(np.int8)
            add += [numpy_helper.from_array(q, init.name + '_q'),
                    numpy_helper.from_array(s.astype(np.float32), init.name + '_s'),
                    numpy_helper.from_array(np.zeros(s.shape, np.int8), init.name + '_z')]
            nodes.append(helper.make_node('DequantizeLinear', [init.name + '_q', init.name + '_s', init.name + '_z'], [init.name], axis=axis))
        drop.append(init)
    for d in drop: g.initializer.remove(d)
    g.initializer.extend(add)
    for n in reversed(nodes): g.node.insert(0, n)
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    return len(drop)

if __name__ == '__main__':
    args = sys.argv[1:]
    k32 = k16 = ()
    if '--fp32' in args: k32 = set(args[args.index('--fp32') + 1].split(','))
    if '--fp16' in args: k16 = set(args[args.index('--fp16') + 1].split(','))
    print('quantized', quantize(args[0], args[1], k32, k16), 'tensors')
