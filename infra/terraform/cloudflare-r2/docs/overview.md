# cloudflare-r2

Provisions the managed R2 bucket Pixvault stores library files in (stage and prod): `pixvault-stage` and `pixvault-prod`. Every object key starts with `org/<orgId>/lib/<libraryId>/`.

Terraform-managed infrastructure, planned and applied per environment by its CI lane.

|              |                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Type         | `terraform`                                                                                          |
| Source       | `infra/terraform/cloudflare-r2`                                                                      |
| Environments | `stage`: `plan-only`, `apply` on a push to `main` · `prod`: `plan-only`, `apply` on a push to `main` |

## Depends on

- (none)

## Depended on by

- **storage-worker** (PV-10): binds the bucket for library uploads, reads and deletes
