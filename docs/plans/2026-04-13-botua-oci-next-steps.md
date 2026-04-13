# Botua OCI — Next Steps

**Date:** 2026-04-13
**Status:** VM running, tools installed, needs networking + service setup

## Current State

```
Instance:  botua-oci
ID:        ocid1.instance.oc1.iad.anuwcljtiwah5fqcrilwnxbhhrinztthq2jzmn57ncf65vgtzsx5zboixqeq
IP:        129.80.124.77 (public, temporary)
Private:   10.0.0.x (check via OCI)
Region:    Ashburn (us-ashburn-1)
AD:        LhXw:US-ASHBURN-AD-1
Shape:     VM.Standard.A1.Flex (2 OCPU, 4 GB RAM)
OS:        Debian 13 trixie ARM64, kernel 6.12.74+deb13+1-cloud-arm64
SSH:       debian@129.80.124.77 (ed25519 + rsa keys)
NSG:       nebula-vpn-4242-nsg (UDP only)
Subnet:    ashburn-subnet (security list allows SSH on 22 + 45620)
```

### Installed Tools
- git 2.47.3
- podman 5.4.2
- bun 1.3.12 (both root and debian user)
- curl, jq, ca-certificates, gnupg, unzip

### GRUB Config
- `console=ttyAMA0` in GRUB_CMDLINE_LINUX (serial console works)
- `grub-install` was run (EFI boot entry registered)
- Cloud kernel: `6.12.74+deb13+1-cloud-arm64`

---

## TODO

### 1. Install Nebula

Join the overlay network as `100.64.20.27` in the `servers` group.

**References:**
- `~/projects/nebula/` — nebula infra repo
- `~/projects/nebula/current-network.md` — IP allocations
- `~/projects/nebula/install-nebula.js` — installer CLI

**Steps:**
1. Generate nebula cert for botua-oci:
   ```bash
   cd ~/projects/nebula
   # Sign cert with CA (nebula-ca/ dir has the CA key)
   nebula-cert sign \
     -name "botua-oci" \
     -ip "100.64.20.27/16" \
     -groups "servers"
   ```
2. Copy cert + key + ca.crt to botua-oci
3. Install nebula binary (ARM64) on botua-oci
4. Configure nebula.yml with lighthouses:
   - `100.64.0.1` → `129.80.52.94:4242` (ashburn-lighthouse)
   - `100.64.20.23` → `129.80.109.216:4242` (infra03-oci, secondary)
5. Enable and start nebula service
6. Verify: `ping 100.64.20.1` from botua-oci
7. Update `~/projects/nebula/current-network.md` with new entry

### 2. Install Cloudflared

Create a CF tunnel to expose botua's webhook endpoint.

**Steps:**
1. Install cloudflared on botua-oci:
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cloudflared.deb
   sudo dpkg -i /tmp/cloudflared.deb
   ```
2. Authenticate: `cloudflared tunnel login` (needs browser — do from Marco's machine or use token)
3. Create tunnel:
   ```bash
   cloudflared tunnel create botua
   ```
4. Configure tunnel (`/etc/cloudflared/config.yml`):
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /root/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: botua.bitua.dev
       service: http://localhost:7800
     - service: http_status:404
   ```
5. DNS: `cloudflared tunnel route dns botua botua.bitua.dev`
6. Enable service: `sudo cloudflared service install && sudo systemctl enable cloudflared`
7. Verify: `curl https://botua.bitua.dev/health` (will 502 until service runs, but tunnel works)

### 3. Remove Public IP

Once nebula + cloudflared are working:

1. SSH via nebula: `ssh debian@100.64.20.27`
2. Verify cloudflared tunnel is up
3. Remove public IP via OCI console or CLI:
   ```bash
   # Get VNIC ID
   oci compute instance list-vnics --region us-ashburn-1 \
     --instance-id "ocid1.instance.oc1.iad.anuwcljtiwah5fqcrilwnxbhhrinztthq2jzmn57ncf65vgtzsx5zboixqeq" \
     --query 'data[0].id' --raw-output
   
   # Update VNIC to remove public IP
   oci network vnic update --vnic-id <VNIC_ID> --skip-source-dest-check true
   ```
   Or just do it from OCI Console → Instance → Attached VNICs → Edit

### 4. Import into Tofu

Create `infra/oci/compute-botua-oci.tf` in platform repo, then import:

```bash
cd ~/projects/platform/infra/oci
tofu import oci_core_instance.botua-oci <instance-ocid>
```

### 5. Start Building Botua Service

With infra ready, start implementing the webhook server:
- See `~/projects/botua/docs/plans/2026-04-08-botua-v2-service-architecture.md`
- Jot note: https://jot.muu.space/s/m4xoxfct8p5ksc
- Clone botua repo on the VM
- Implement `src/server.ts` with `Bun.serve()`
- Test webhook endpoint via cloudflare tunnel

---

## Key Learnings (from this session)

### Debian 13 + OCI ARM64 Boot Issues

- **OCI UEFI NVRAM is instance-specific** — not captured in image snapshots
- **`grub-install` must run on each specific VM** to register EFI boot entry
- **Debian 13 GRUB has gfxterm bug** (#1111240) — hangs on serial-only console
- **Working approach:** launch from Debian 12 → apt upgrade to 13 → grub-install
- **`console=ttyAMA0`** needed in GRUB_CMDLINE_LINUX for serial output
- **netboot.xyz** works for native Debian 13 install on OCI ARM64

### OCI Infra Quick Reference

| Resource | Value |
|---|---|
| Compartment | `ocid1.tenancy.oc1..aaaaaaaa6zdofduo6pw7wsh2g57zxzkvknk57vv7ftxbba3u3mkkosdez6ca` |
| Subnet | `ocid1.subnet.oc1.iad.aaaaaaaasfxk23arqtk2ey5s53zk623jlto4womqn3rfnug4gxpfdqyhdegq` |
| Nebula NSG | `ocid1.networksecuritygroup.oc1.iad.aaaaaaaavh56rzyoenj4ewc2363lkkwode7zcev5vhvjxor4czxgbt62gqiq` |
| Debian 12 ARM64 | `ocid1.image.oc1.iad.aaaaaaaa4mf7z4vnf26gxw23ghwbmma6fni34nmgpcy23uosbronokgejqvq` |
| OCI namespace | `axfvcjz3yvci` |
| Images bucket | `custom-images-ashburn-2` |
