import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { DynamoDBAdapter } from "@next-auth/dynamodb-adapter";
import { docClient } from "@/lib/dynamodb";

export const authOptions: NextAuthOptions = {
  // 'as any' is required to bypass the internal AWS SDK v3 type mismatch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter expects DocumentClient shape
  adapter: DynamoDBAdapter(docClient as any, {
    tableName: "TempoFlow-Users",
    partitionKey: "pk",
    sortKey: "sk",
    indexName: "GSI1",
    indexPartitionKey: "gsi1pk",
    indexSortKey: "gsi1sk",
  }),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
