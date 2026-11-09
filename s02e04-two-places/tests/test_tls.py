"""TLS through a private CA (the cloud proxy case): trusted only via SSL_CERT_FILE; errors unwrapped."""
from __future__ import annotations

import datetime as dt
import ipaddress
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import fake_job_server as fake  # noqa: E402
import mcp_call  # noqa: E402
from test_http import free_port  # noqa: E402


def make_ca_and_cert(tmp: Path) -> tuple[Path, Path, Path]:
    now = dt.datetime.now(dt.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test proxy CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(1).not_valid_before(now - dt.timedelta(minutes=1)).not_valid_after(now + dt.timedelta(hours=1))
          .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False,
                                       key_encipherment=False, data_encipherment=False, key_agreement=False,
                                       encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")]))
            .issuer_name(ca_name).public_key(key.public_key()).serial_number(2)
            .not_valid_before(now - dt.timedelta(minutes=1)).not_valid_after(now + dt.timedelta(hours=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    ca_pem, cert_pem, key_pem = tmp / "ca.pem", tmp / "cert.pem", tmp / "key.pem"
    ca_pem.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    cert_pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_pem.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    return ca_pem, cert_pem, key_pem


def test_describe_unwraps_groups():
    try:
        try:
            raise ConnectionError("tls failed")
        except ConnectionError as inner:
            raise ExceptionGroup("unhandled errors in a TaskGroup", [RuntimeError("connect")]) from inner
    except ExceptionGroup as e:
        text = mcp_call.describe(e)
    assert "RuntimeError: connect" in text


def test_https_with_private_ca_via_env(tmp_path):
    ca, cert, key = make_ca_and_cert(tmp_path)
    port = free_port()
    app = fake.build_job2().streamable_http_app(stateless_http=True)
    uv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                       ssl_certfile=str(cert), ssl_keyfile=str(key)))
    th = threading.Thread(target=uv.run, daemon=True)
    th.start()
    for _ in range(100):
        if uv.started:
            break
        time.sleep(0.05)
    try:
        env = {k: v for k, v in os.environ.items() if k not in mcp_call.CA_ENV}
        env["JOB_LINK"] = f"https://127.0.0.1:{port}/mcp"
        base = [sys.executable, str(TOOLS / "mcp_call.py"), "--worker", "W2", "--job", "job-2", "--link-env", "JOB_LINK"]
        r = subprocess.run(base + ["--trace", str(tmp_path / "t1.jsonl"), "tools"], capture_output=True, text=True, env=env, timeout=60)
        assert r.returncode == 4
        err = json.loads(r.stdout)["error"]
        assert "CERTIFICATE_VERIFY_FAILED" in err, err
        env["SSL_CERT_FILE"] = str(ca)
        r = subprocess.run(base + ["--trace", str(tmp_path / "t2.jsonl"), "tools"], capture_output=True, text=True, env=env, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "transcribe" in r.stdout
    finally:
        uv.should_exit = True
        th.join(timeout=10)
