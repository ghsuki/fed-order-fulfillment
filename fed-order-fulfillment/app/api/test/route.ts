import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export async function GET(request: NextRequest) {
  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    console.log('Testing Claude API...');
    console.log('API Key present:', !!process.env.ANTHROPIC_API_KEY);
    console.log('API Key length:', process.env.ANTHROPIC_API_KEY?.length);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: 'Say hello briefly',
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    console.log('✓ Claude API call successful');
    return NextResponse.json({
      success: true,
      model: response.model,
      message: content.text,
      tokens_input: response.usage.input_tokens,
      tokens_output: response.usage.output_tokens,
    });
  } catch (error) {
    console.error('Claude API test failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
