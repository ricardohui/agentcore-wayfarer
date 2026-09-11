import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { confusedDeputyTrustPrincipal } from "./confused-deputy-trust-principal";

const CONTENT_SOURCE_DIR = path.join(__dirname, "../../../src/destination-guides/content");

// Knowledge Base's destination-guide content (issue #21 / ADR-0010): a
// Bedrock **Managed** Knowledge Base (`type: MANAGED`) — fully managed by
// Bedrock, no vector store/embedding model to provision or configure — with
// one S3 data source over the 3 authored per-city docs. Queried directly by
// the Runtime's own bedrock-agent-runtime Retrieve call — no Gateway target.
export class KnowledgeBaseConstruct extends cdk.Resource {
  public readonly bucket: s3.Bucket;
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly dataSource: bedrock.CfnDataSource;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "ContentBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "ContentDeployment", {
      sources: [s3deploy.Source.asset(CONTENT_SOURCE_DIR)],
      // See price-check-site-construct.ts's identical cast: aws-cdk-lib's
      // IBucket/Bucket typings disagree on `isWebsite`'s optionality under
      // this project's exactOptionalPropertyTypes.
      destinationBucket: this.bucket as s3.IBucket,
    });

    // Trust policy scoped to this account's knowledge bases, with confused
    // deputy protection — matches the AWS-documented KB service role trust
    // relationship. Permissions are S3-only: a Managed KB's whole pitch is
    // no embedding model/vector store to grant access to (unlike a classic
    // KB's AmazonBedrockExecutionRoleForKB, which also needs
    // bedrock:InvokeModel on an embedding model).
    const knowledgeBaseRole = new iam.Role(this, "KnowledgeBaseRole", {
      description: "Wayfarer destination-guides Knowledge Base's service role - reads its S3 content bucket",
      assumedBy: confusedDeputyTrustPrincipal(this, "bedrock.amazonaws.com", "bedrock", "knowledge-base"),
    });
    this.bucket.grantRead(knowledgeBaseRole);

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: "wayfarer-destination-guides",
      description: "Wayfarer destination-guide content - visa/climate/customs/packing per scenario city (issue #21)",
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "MANAGED",
        managedKnowledgeBaseConfiguration: { embeddingModelType: "MANAGED" },
      },
    });

    // A Managed KB's data source is NOT the classic `S3` type/`s3Configuration`
    // pair (that's self-managed-KB-only, confirmed live: "Unsupported data
    // source type for MANAGED knowledge base type") — it's the generic
    // `MANAGED_KNOWLEDGE_BASE_CONNECTOR` type, with the S3 connector selected
    // via `connectorParameters.type: "S3"` and a bucket *name* (not ARN).
    // `bucketOwnerAccountId` is documented as "Conditional - required for
    // cross-account access" but confirmed live: CreateDataSource accepts it
    // as absent, then the async data-source creation itself fails
    // ("Member must not be null") even for this same-account bucket — so
    // it's supplied unconditionally.
    this.dataSource = new bedrock.CfnDataSource(this, "DataSource", {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: "wayfarer-destination-guides-s3",
      dataSourceConfiguration: {
        type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
        managedKnowledgeBaseConnectorConfiguration: {
          connectorParameters: {
            type: "S3",
            version: "1",
            connectionConfiguration: {
              bucketName: this.bucket.bucketName,
              bucketOwnerAccountId: cdk.Stack.of(this).account,
            },
          },
        },
      },
    });
  }
}
