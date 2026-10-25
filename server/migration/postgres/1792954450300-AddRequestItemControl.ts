import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestItemControl1792954450300 implements MigrationInterface {
  name = 'AddRequestItemControl1792954450300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "request_item_control" ("id" SERIAL NOT NULL, "seasonNumber" integer, "episodeNumber" integer, "state" character varying NOT NULL, "pausedAtPercent" integer, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "requestId" integer, "createdById" integer, CONSTRAINT "PK_request_item_control_id" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d62b3d8f549664cc6e0211a27d" ON "request_item_control" ("requestId") `
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_47661e7964297c6f917d609174" ON "request_item_control" ("requestId", "seasonNumber", "episodeNumber") `
    );
    await queryRunner.query(
      `ALTER TABLE "request_item_control" ADD CONSTRAINT "FK_d62b3d8f549664cc6e0211a27da" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "request_item_control" ADD CONSTRAINT "FK_13e7f76eaca3c83a245f40c9879" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "request_item_control" DROP CONSTRAINT "FK_13e7f76eaca3c83a245f40c9879"`
    );
    await queryRunner.query(
      `ALTER TABLE "request_item_control" DROP CONSTRAINT "FK_d62b3d8f549664cc6e0211a27da"`
    );
    await queryRunner.query(`DROP INDEX "IDX_47661e7964297c6f917d609174"`);
    await queryRunner.query(`DROP INDEX "IDX_d62b3d8f549664cc6e0211a27d"`);
    await queryRunner.query(`DROP TABLE "request_item_control"`);
  }
}
